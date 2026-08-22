import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AppServer } from "../src/server/http/appServer";
import { DEFAULT_CLIENT_UPDATE_URL, type AppServerConfig } from "../src/server/config";

let server:AppServer|undefined;
afterEach(async()=>{await server?.close();server=undefined;});

describe("admin console",()=>{
  it("issues and revokes an application token through an authenticated CSRF-protected session",async()=>{
    const dir=mkdtempSync(join(tmpdir(),"mentor-admin-"));const bootstrap=join(dir,"bootstrap.json");writeFileSync(bootstrap,JSON.stringify({adminId:"operator",password:"correct-horse-battery"}));
    const config:AppServerConfig={host:"127.0.0.1",port:0,serverToken:"legacy-token",clientUpdateUrl:DEFAULT_CLIENT_UPDATE_URL,llmMode:"local",openAiModel:"gpt-5.4-mini",geminiModel:"gemini-3.5-flash",llmMaxCalls:3,llmMaxTransportRetries:1,llmAttemptTimeoutMs:45000,llmTotalTimeoutMs:105000,llmRetryBaseDelayMs:0,llmCircuitFailureThreshold:3,llmCircuitOpenMs:30000,llmMaxConcurrentRequests:4,mentorStreamingEnabled:false,skillsExecutionEnabled:true,mcpToolsEnabled:true,customInstructionExecutionEnabled:true,customInstructionReviewEnabled:true,capabilityReviewEnabled:true,allowedOrigins:[],adminEnabled:true,databasePath:join(dir,"app.db"),adminBootstrapFile:bootstrap,settingsMasterKey:Buffer.alloc(32,4).toString("base64")};
    server=new AppServer(config);const port=await server.listen();const base=`http://127.0.0.1:${port}`;
    const login=await fetch(`${base}/api/admin/login`,{method:"POST",headers:{"content-type":"application/json",origin:base},body:JSON.stringify({adminId:"operator",password:"correct-horse-battery"})});expect(login.status).toBe(200);const csrf=(await login.json() as {csrf:string}).csrf;const cookie=login.headers.get("set-cookie")!.split(";")[0]!;
    const authHeaders={"content-type":"application/json",origin:base,cookie,"x-mentor-csrf":csrf};
    const created=await fetch(`${base}/api/admin/users`,{method:"POST",headers:authHeaders,body:JSON.stringify({slug:"team-a",displayName:"Team A"})});expect(created.status).toBe(201);const user=await created.json() as {id:number};
    const issued=await fetch(`${base}/api/admin/tokens`,{method:"POST",headers:authHeaders,body:JSON.stringify({userId:user.id,label:"CI"})});expect(issued.status).toBe(201);const token=await issued.json() as {id:number;token:string};
    expect((await fetch(`${base}/api/token/verify`,{method:"POST",headers:{"x-mentor-token":token.token}})).status).toBe(200);
    expect((await fetch(`${base}/api/admin/tokens/${token.id}`,{method:"DELETE",headers:authHeaders,body:JSON.stringify({password:"correct-horse-battery"})})).status).toBe(204);
    expect((await fetch(`${base}/api/token/verify`,{method:"POST",headers:{"x-mentor-token":token.token}})).status).toBe(401);
    const providerSecret="test-provider-secret-value";
    expect((await fetch(`${base}/api/admin/connections`,{method:"POST",headers:authHeaders,body:JSON.stringify({type:"openai",name:"Primary",apiKey:providerSecret})})).status).toBe(201);
    expect(readFileSync(join(dir,"app.db")).includes(Buffer.from(providerSecret))).toBe(false);
  });
});
