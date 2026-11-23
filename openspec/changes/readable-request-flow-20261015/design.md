# 设计

上方五步从左到右：提问→受理→准备资料→模型判断→保存并显示答复。需要工具时向下进入后端门禁；只读结果向上回到Agent，修改则生成待审批并结束本轮。独立审批泳道使用虚线连接，不向原模型循环回连。

深蓝画布、蓝色主线、青色只读回路、琥珀色审批；本机字体，无外部资源。桌面以SVG呈现完整分支，手机以相同节点和当前示例生成顺序列表。完整SVG仍可导出。步骤演示默认暂停，自动演示在待审批处暂停，后续审批需手动继续查看；切例子、离开页面暂停。

数据源为docs/diagrams/request-flow.json，模板为docs/web/request-flow.html，由scripts/build-request-flow.mjs生成docs/site/request-flow.html，docs:build/docs:check同时生成/检查。不再宣称请求图是Archify组件规格或沿用旧视觉校验结果。
