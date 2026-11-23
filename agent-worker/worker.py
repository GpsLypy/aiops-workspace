"""One run per private stdio connection. No provider or MCP credentials here."""
import asyncio
import contextlib
import importlib.metadata
import importlib
import json
import os
import shutil
import sys
import tempfile
import threading

WIRE = sys.stdout
LIMIT = 2_000_000
VERSION = "2.0.8"


def read_frame():
    line = sys.stdin.buffer.readline(LIMIT + 1)
    if not line:
        raise EOFError("Bridge closed")
    if len(line) > LIMIT or not line.endswith(b"\n"):
        raise RuntimeError("Invalid bridge frame")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise RuntimeError("Invalid bridge envelope")
    return value


def send(value):
    data = json.dumps(value, ensure_ascii=False, allow_nan=False)
    if len(data.encode()) > LIMIT:
        raise RuntimeError("Bridge frame too large")
    WIRE.write(data + "\n")
    WIRE.flush()


def use_private_tempdir(directory):
    os.environ["TMPDIR"] = directory
    tempfile.tempdir = directory


def preload():
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("Worker requires Python 3.12")
    if importlib.metadata.version("agentscope") != VERSION:
        raise RuntimeError("AgentScope version mismatch")
    for name in ("agent", "credential", "event", "message", "model", "permission", "tool", "middleware", "formatter"):
        importlib.import_module("agentscope." + name)


async def main(expected_run_id=None):
    preload()
    from agentscope.agent import Agent, ContextConfig, InjectionConfig, ModelConfig, ReActConfig
    from agentscope.credential import OpenAICredential
    from agentscope.event import RequireExternalExecutionEvent, ExternalExecutionResultEvent
    from agentscope.message import UserMsg, AssistantMsg, Msg, TextBlock, ToolCallBlock, ToolResultBlock, ToolResultState
    from agentscope.model import ChatModelBase, ChatResponse, ChatUsage
    from agentscope.permission import PermissionDecision, PermissionBehavior
    from agentscope.tool import ToolBase, Toolkit
    from agentscope.middleware import MiddlewareBase
    from agentscope.formatter import OpenAIChatFormatter

    start = read_frame()
    if start.get("version") != 1 or start.get("type") != "start":
        raise RuntimeError("Unsupported bridge protocol")
    run_id = start["runId"]
    if expected_run_id is not None and run_id != expected_run_id:
        raise RuntimeError("Start does not match lease")
    seq = 0

    async def rpc(kind, **payload):
        nonlocal seq
        seq += 1
        send({"version": 1, "runId": run_id, "id": seq, "type": kind, **payload})
        response = await asyncio.to_thread(read_frame)
        if response.get("runId") != run_id or response.get("id") != seq or response.get("version") != 1:
            raise RuntimeError("Bridge response mismatch")
        if not response.get("ok"):
            raise RuntimeError("Bridge rejected request")
        return response["result"]

    class ModelBridge(ChatModelBase):
        type = "aiops_bridge"

        def __init__(self):
            # Placeholder only: _call_api never constructs a provider client.
            super().__init__(credential=OpenAICredential(api_key="unused-local-bridge"),
                             model="aiops-controlled-model", parameters=self.Parameters(),
                             stream=False, max_retries=0, context_size=1_000_000_000)
            self.formatter = OpenAIChatFormatter()

        async def _call_api(self, model_name, messages, tools=None, tool_choice=None, **kwargs):
            # Node owns the canonical, uncompressed transcript, including opaque
            # Responses reasoning items. v1 deliberately preserves legacy context.
            result = await rpc("model")
            message = result["message"]
            content = []
            if message.get("content"):
                content.append(TextBlock(text=message["content"]))
            for call in message.get("tool_calls", []):
                content.append(ToolCallBlock(id=call["id"], name=call["function"]["name"], input=call["function"]["arguments"]))
            if not content:
                content.append(TextBlock(text=""))
            usage = result.get("usage") or {}
            return ChatResponse(content=content, is_last=True, usage=ChatUsage(
                input_tokens=int(usage.get("prompt_tokens") or 0),
                output_tokens=int(usage.get("completion_tokens") or 0), time=0))

    class ExternalTool(ToolBase):
        is_external_tool = True
        is_concurrency_safe = False
        is_read_only = False

        def __init__(self, definition):
            super().__init__()
            self.name = definition["name"]
            self.description = definition["description"]
            # Strict authoritative validation takes place in Node before the
            # response reaches AgentScope. Do not add Python schema repair.
            self.input_schema = {"type": "object", "properties": {}, "additionalProperties": True}

        async def check_permissions(self, tool_input, context):
            return PermissionDecision(behavior=PermissionBehavior.ALLOW,
                                      message="Submit to Node governance; no execution authority")

    class NoCompression(MiddlewareBase):
        async def on_compress_context(self, agent, input_kwargs, next_handler):
            # The hook is called before every reasoning iteration, even below
            # the threshold. Node enforces context bounds; omit next_handler.
            return None

    agent = Agent(name="aiops", system_prompt=start["system"], model=ModelBridge(),
                  toolkit=Toolkit(tools=[ExternalTool(t) for t in start["tools"]]),
                  middlewares=[NoCompression()],
                  model_config=ModelConfig(max_retries=0),
                  context_config=ContextConfig(compression_tool_enabled=False, compression_fallback_to_truncation=False),
                  injection_config=InjectionConfig(inject_runtime_state=False),
                  react_config=ReActConfig(max_iters=6, stop_on_reject=True))
    inputs = [(UserMsg if m["role"] == "user" else AssistantMsg)(name=m["role"], content=m["content"])
              for m in start["history"]]
    while True:
        pending = []
        final = None
        async for event in agent.reply_stream(inputs, yield_final_msg=True):
            if isinstance(event, RequireExternalExecutionEvent):
                pending.append(event)
            elif isinstance(event, Msg):
                final = event
        if pending:
            # Sequential tools yield one pending batch; process every member
            # before resume, because partial results are not re-emitted.
            reply_ids = {e.reply_id for e in pending}
            if len(reply_ids) != 1:
                raise RuntimeError("Mixed replies")
            results = []
            for event in pending:
                for call in event.tool_calls:
                    result = await rpc("tool", replyId=event.reply_id, callId=call.id,
                                       name=call.name, arguments=call.input)
                    if result.get("pending"):
                        send({"version": 1, "runId": run_id, "type": "finish", "status": "awaiting_approval"})
                        return
                    results.append(ToolResultBlock(id=call.id, name=call.name,
                                   output=[TextBlock(text=result["content"])], state=ToolResultState.SUCCESS))
            inputs = ExternalExecutionResultEvent(reply_id=pending[0].reply_id, execution_results=results)
            continue
        reason = final.finished_reason.value if final and final.finished_reason is not None else None
        send({"version": 1, "runId": run_id, "type": "finish", "status": reason})
        return


def run_once(expected_run_id=None):
    try:
        with contextlib.redirect_stdout(sys.stderr):
            asyncio.run(main(expected_run_id))
        return 0
    except BaseException:
        # Never send library exceptions or raw context to logs/the browser.
        send({"version": 1, "type": "fatal", "code": "WORKER_FAILED"})
        return 1


def pool_main():
    # A single-threaded, preloaded parent never receives business context.
    # Only its disposable child reads start/model/tool frames. No Agent object
    # or asyncio event loop is ever created or reset in the parent.
    if os.name != "posix":
        raise RuntimeError("Prefork mode requires POSIX")
    import resource

    with contextlib.redirect_stdout(sys.stderr):
        preload()
    os.umask(0o077)

    def usage(value):
        return {"maxRssBytes": int(value.ru_maxrss * (1 if sys.platform == "darwin" else 1024)),
                "cpuSeconds": value.ru_utime + value.ru_stime}

    def ready(**extra):
        send({"version": 2, "type": "ready", "sdk": VERSION, "pid": os.getpid(),
              "parentUsage": usage(resource.getrusage(resource.RUSAGE_SELF)), **extra})

    ready()
    while True:
        try:
            lease = read_frame()
        except EOFError:
            return
        if lease.get("version") != 2 or lease.get("type") != "lease" or not isinstance(lease.get("runId"), str):
            raise RuntimeError("Invalid pool lease")
        if threading.active_count() != 1:
            raise RuntimeError("Preloader must remain single threaded")
        WIRE.flush()
        sys.stderr.flush()
        pid = os.fork()
        if pid == 0:
            directory = tempfile.mkdtemp(prefix="run-", dir=os.getcwd())
            os.chdir(directory)
            use_private_tempdir(directory)
            code = 1
            try:
                send({"version": 2, "type": "leased", "runId": lease["runId"], "pid": os.getpid()})
                code = run_once(lease["runId"])
            finally:
                os.chdir("..")
                shutil.rmtree(directory, ignore_errors=True)
                os._exit(code)
        _, status, stats = os.wait4(pid, 0)
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
            raise RuntimeError("Run child failed")
        ready(runId=lease["runId"], childPid=pid, childUsage=usage(stats))
        del lease


if __name__ == "__main__":
    if sys.argv[1:] == ["--pool"]:
        try:
            pool_main()
        except BaseException:
            send({"version": 2, "type": "fatal", "code": "POOL_FAILED"})
            sys.exit(1)
    else:
        sys.exit(run_once())
