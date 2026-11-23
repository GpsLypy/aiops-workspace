import {chromium} from 'playwright';
import express from 'express';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {listen} from '../tests/fixtures.mjs';
const output=resolve('test-results/agent-selector-20261009');mkdirSync(output,{recursive:true});
const user={id:'member',username:'member',name:'运维同学',role:'member',active:true};
let resources=[{id:'cost',kind:'agents',name:'成本分析',description:'分析资源开销，定位费用变化与优化空间。',status:'已启用',skillIds:[],mcpIds:[],knowledgeIds:[],visibility:'public'},{id:'dts',kind:'agents',name:'DTS 运维',description:'查询传输任务状态，核对延迟与异常。',status:'已启用',skillIds:[],mcpIds:[],knowledgeIds:[],visibility:'public'}];
const history={id:'history',user_id:user.id,title:'既有 DTS 会话',owner:user.name,agent_id:'dts',messages:[{seq:1,role:'user',content:'保留既有会话',metadata:{},created:new Date().toISOString()}]};
const app=express();let posts=0;
app.use('/api', (req,res)=>{
 if(req.method!=='GET'){posts++;return res.status(400).json({error:'This visual fixture must remain read-only'});}
 if(req.path==='/auth/me')return res.json(user);
 if(req.path==='/resources')return res.json(resources);
 if(req.path==='/conversations')return res.json([history]);
 if(req.path==='/conversations/history')return res.json(history);
 if(req.path==='/model/status')return res.json({configured:true,model:'gpt-6-luna',model_reasoning_effort:'medium'});
 return res.json({});
});app.use(express.static(resolve('dist')));const http=await listen(app);
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
const checks=[],errors=[];
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(http.url+'/#chat');const trigger=()=>page.getByRole('button',{name:'Agent',exact:true});
 await trigger().waitFor();
 const style=await trigger().evaluate(el=>({border:getComputedStyle(el).borderWidth,height:el.getBoundingClientRect().height}));assert.equal(style.border,'1px');assert.equal(style.height,32);
 await trigger().click();const menu=()=>page.getByRole('listbox',{name:'选择 Agent'});
 assert.equal(await menu().getByRole('option').count(),3);assert.equal(await menu().getByRole('option').first().getAttribute('aria-selected'),'true');
 assert.match(await menu().innerText(),/不限子领域[\s\S]*成本分析[\s\S]*定位费用变化[\s\S]*DTS 运维/);
 await page.screenshot({path:join(output,'desktop-menu.png')});
 await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');assert.equal(await trigger().innerText(),'成本分析');assert.equal(await trigger().evaluate(el=>el===document.activeElement),true);
 await trigger().click();assert.equal(await menu().getByRole('option').nth(1).getAttribute('aria-selected'),'true');await page.keyboard.press('End');await page.keyboard.press('Home');assert.equal(await menu().getByRole('option').first().evaluate(el=>el===document.activeElement),true);await page.keyboard.press('Escape');assert.equal(await trigger().evaluate(el=>el===document.activeElement),true);
 checks.push('bordered aligned trigger; descriptive rows, selected check; keyboard selection, Home/End/Escape and focus return');
 await trigger().click();await page.getByRole('textbox',{name:'输入你的问题'}).click();assert.equal(await menu().count(),0);
 await trigger().click();await page.keyboard.press('Tab');assert.equal(await menu().count(),0);assert.equal(await trigger().evaluate(el=>el===document.activeElement),false);assert.equal(await page.locator('.agent-menu').count(),0);
 checks.push('outside click and Tab close without trapping focus');
 for(const width of[1280,320]){
  await page.setViewportSize({width,height:width===320?568:900});await trigger().click();
  const rect=await page.locator('.agent-menu').boundingBox();assert.ok(rect&&rect.x>=11&&rect.x+rect.width<=width-11&&rect.y>=11&&rect.y+rect.height<=(width===320?568:900)-11);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(output,`menu-${width}.png`)});await page.keyboard.press('Escape');
 }
 checks.push('desktop and 320px panel positioning and composer without horizontal overflow');
 await page.setViewportSize({width:1280,height:900});await page.getByRole('button',{name:history.title,exact:true}).click();await trigger().filter({hasText:'DTS 运维'}).waitFor();assert.equal(await trigger().isDisabled(),true);assert.match(await trigger().getAttribute('title'),/新建会话后可切换/);
 resources=resources.map(r=>r.id==='dts'?{...r,status:'已停用'}:r);await page.reload();await page.getByRole('button',{name:history.title,exact:true}).click();await trigger().filter({hasText:'已停用'}).waitFor();assert.equal(await trigger().isDisabled(),true);assert.match(await trigger().innerText(),/DTS 运维/);
 resources=resources.filter(r=>r.id!=='dts');await page.reload();await page.getByRole('button',{name:history.title,exact:true}).click();await trigger().filter({hasText:'不可用'}).waitFor();assert.doesNotMatch(await trigger().innerText(),/通用/);
 checks.push('history remains locked; disabled and invisible Agent identity retained');
 resources=[];await page.reload();await trigger().click();assert.equal(await menu().getByRole('option').count(),1);assert.match(await menu().innerText(),/通用 Agent.*不限子领域/s);await page.keyboard.press('Escape');
 checks.push('general-only workspace keeps a usable bordered entry and explains its purpose');
 resources=Array.from({length:16},(_,i)=>({id:'long-'+i,kind:'agents',name:i===0?'很长的生产数据传输与数据库稳定性巡检 Agent':'专用 Agent '+i,description:'提供具体用途说明，不会改变现有授权范围。'.repeat(4),status:'已启用'}));
 await page.reload();await page.setViewportSize({width:320,height:568});await trigger().click();await page.keyboard.press('End');await page.keyboard.press('Enter');assert.match(await trigger().innerText(),/专用 Agent 15/);
 await trigger().click();await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:join(output,'long-name-320.png')});
 checks.push('long names and many options scroll and remain operable on 320px');
 assert.equal(posts,0);assert.deepEqual(errors,[]);writeFileSync(join(output,'report.json'),JSON.stringify({checkedAt:new Date().toISOString(),mode:'read-only visual fixture',checks,errors,posts},null,2));console.log(JSON.stringify({checks,errors,posts}));
}finally{await browser.close();await http.close();}
