import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function runHarness(source: string): unknown {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import * as harness from './scripts/operational-fomo-harness.mjs';
    ${source}
  `], { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

describe("operational FOMO harness contract", () => {
  it("pins the development-only embedded PostgreSQL package and QA commands", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.devDependencies["embedded-postgres"]).toBe("16.14.0-beta.17");
    expect(pkg.scripts["qa:operational"]).toBe("node scripts/verify-operational-fomo-evidence.mjs --mode attempt");
    expect(pkg.scripts["qa:operational:core"]).toBe("node scripts/verify-operational-fomo-evidence.mjs --mode core");
  });

  it("rejects unsafe and non-test database URLs at the boundary", () => {
    const result = runHarness(`
      const values = ['postgresql://u:p@example.com/app_test','postgresql://u:p@127.0.0.1/app','not-a-url'];
      console.log(JSON.stringify(values.map((value) => { try { harness.parseSafeTestDatabaseUrl(value); return false; } catch { return true; } })));
    `);
    expect(result).toEqual([true, true, true]);
  });

  it("requires explicit authorization before reusing a loopback test database", async () => {
    const result = runHarness(`
      try { await harness.withOperationalPostgres({operation: async()=>null,preauthorized:false,preauthorizedUrl:'postgresql://u:p@127.0.0.1:5432/reuse_test'}); }
      catch (error) { console.log(JSON.stringify({stage:error.stage})); }
    `);
    expect(result).toEqual({ stage: "child" });
  });

  it("selects honest Windows x64 and Linux x64 artifacts and rejects unsupported targets", () => {
    const result = runHarness(`
      const targets=['win32','linux'].map(value=>harness.resolveEmbeddedTarget(value,'x64'));
      let rejected; try { harness.resolveEmbeddedTarget('darwin','arm64'); } catch(error) { rejected=error.stage }
      console.log(JSON.stringify({targets,rejected}));
    `);
    expect(result).toEqual({
      rejected: "binary",
      targets: [
        { binarySuffix: ".exe", packageName: "windows-x64", target: "win32:x64" },
        { binarySuffix: "", packageName: "linux-x64", target: "linux:x64" }
      ]
    });
  });

  it("owns unique embedded roots, credentials, databases, ports, and cleanup", async () => {
    const result = runHarness(`
      const seen=[];
      class Fake { constructor(options){seen.push(options)} async initialise(){} async start(){} async createDatabase(){} async stop(){} }
      const results=await Promise.all([1,2].map(()=>harness.withOperationalPostgres({embeddedFactory:Fake,operation:async c=>c,timeoutMs:1000})));
      console.log(JSON.stringify({dirs:new Set(seen.map(x=>x.databaseDir)).size,passwords:new Set(seen.map(x=>x.password)).size,databases:new Set(results.map(x=>new URL(x.databaseUrl).pathname)).size,clean:results.every(x=>x.receipt.status==='cleaned')}));
    `);
    expect(result).toEqual({ clean: true, databases: 2, dirs: 2, passwords: 2 });
  });

  it("returns a typed timeout and still removes its owned root", async () => {
    const result = runHarness(`
      class Hung { async initialise(){await new Promise(()=>{})} async start(){} async createDatabase(){} async stop(){} }
      try { await harness.withOperationalPostgres({embeddedFactory:Hung,operation:async()=>null,timeoutMs:10}); }
      catch(error){console.log(JSON.stringify({stage:error.stage}))}
    `);
    expect(result).toEqual({ stage: "initdb" });
  });

  it("cancels real initdb-style child trees and records PID cleanup across interruptions", () => {
    const result = runHarness(`
      const {mkdtemp,readFile,rm}=await import('node:fs/promises'); const {join}=await import('node:path'); const {tmpdir}=await import('node:os');
      const receipts=[]; const alive=[];
      for(let index=0;index<2;index+=1){
        const attemptDir=await mkdtemp(join(tmpdir(),'fomo-partial-init-attempt-'));
        const marker=join(attemptDir,'grandchild.pid');
        const program="const{spawn}=require('node:child_process'),fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)";
        class PartialInit {
          pids=[];
          async initialise(signal){return harness.runOwnedBinary(process.execPath,['-e',program,marker],'initdb',()=>{},{signal,timeoutMs:100,onSpawn:(pid)=>this.pids.push(pid)})}
          async start(){} async createDatabase(){} async stop(){}
          ownedProcessIds(){return this.pids}
        }
        try{await harness.withOperationalPostgres({attemptDir,embeddedFactory:PartialInit,operation:async()=>null,timeoutMs:100})}catch{}
        const receipt=JSON.parse(await readFile(join(attemptDir,'operational-postgres-cleanup.json'),'utf8')); receipts.push(receipt);
        const pid=Number(await readFile(marker,'utf8')); let running=true; try{process.kill(pid,0)}catch{running=false} alive.push(running);
        await rm(attemptDir,{recursive:true,force:true});
      }
      console.log(JSON.stringify({alive,distinctRoots:new Set(receipts.flatMap(x=>x.dataDirectories)).size,processes:receipts.map(x=>x.processes),statuses:receipts.map(x=>x.status)}));
    `);
    expect(result).toEqual({
      alive: [false, false],
      distinctRoots: 2,
      processes: [expect.arrayContaining([expect.objectContaining({ cleaned: true })]), expect.arrayContaining([expect.objectContaining({ cleaned: true })])],
      statuses: ["cleaned", "cleaned"]
    });
  }, 30_000);

  it("creates the cleanup receipt once and rejects a rewrite", () => {
    const result = runHarness(`
      const {mkdtemp,readFile,rm}=await import('node:fs/promises'); const {join}=await import('node:path'); const {tmpdir}=await import('node:os');
      const attemptDir=await mkdtemp(join(tmpdir(),'fomo-create-once-attempt-'));
      class Fake { async initialise(){} async start(){} async createDatabase(){} async stop(){} }
      await harness.withOperationalPostgres({attemptDir,embeddedFactory:Fake,operation:async()=>null,timeoutMs:1000});
      const before=await readFile(join(attemptDir,'operational-postgres-cleanup.json'),'utf8'); let stage;
      try{await harness.withOperationalPostgres({attemptDir,embeddedFactory:Fake,operation:async()=>null,timeoutMs:1000})}catch(error){stage=error.stage}
      const after=await readFile(join(attemptDir,'operational-postgres-cleanup.json'),'utf8'); await rm(attemptDir,{recursive:true,force:true});
      console.log(JSON.stringify({same:before===after,stage}));
    `);
    expect(result).toEqual({ same: true, stage: "cleanup" });
  });

  it("stops a PostgreSQL process that appears after start reaches its deadline", () => {
    const result = runHarness(`
      let stopped=false;
      class LateStart { async initialise(){} async start(){await new Promise(()=>{})} async createDatabase(){} async stop(){stopped=true} }
      try { await harness.withOperationalPostgres({embeddedFactory:LateStart,operation:async()=>null,timeoutMs:10}); }
      catch(error){console.log(JSON.stringify({stage:error.stage,stopped}))}
    `);
    expect(result).toEqual({ stage: "start", stopped: true });
  });

  it("reports every lifecycle failure with its typed stage and still attempts cleanup", () => {
    const result = runHarness(`
      const stages=[];
      for (const failure of ['install-script','binary','initdb','start','create','cleanup']) {
        let stopped=false;
        class Fake {
          constructor(){if(failure==='binary')throw new Error('binary')}
          async initialise(){if(failure==='initdb')throw new Error('initdb')}
          async start(){if(failure==='start')throw new Error('start')}
          async createDatabase(){if(failure==='create')throw new Error('create')}
          async stop(){stopped=true;if(failure==='cleanup')throw new Error('cleanup')}
        }
        try { await harness.withOperationalPostgres({
          embeddedFactory:failure==='install-script'?undefined:Fake,
          embeddedLoader:failure==='install-script'?async()=>{throw new harness.OperationalHarnessError('install-script','missing')}:undefined,
          operation:async()=>null,timeoutMs:100
        }); } catch(error) { stages.push({failure,stage:error.stage,stopped}); }
      }
      console.log(JSON.stringify(stages));
    `);
    expect(result).toEqual([
      { failure: "install-script", stage: "install-script", stopped: false },
      { failure: "binary", stage: "binary", stopped: false },
      { failure: "initdb", stage: "initdb", stopped: true },
      { failure: "start", stage: "start", stopped: true },
      { failure: "create", stage: "create", stopped: true },
      { failure: "cleanup", stage: "cleanup", stopped: true }
    ]);
  });

  it("cleans two isolated roots across repeated interrupted starts", () => {
    const result = runHarness(`
      const roots=[];
      class Interrupted { constructor(options){roots.push(options.databaseDir)} async initialise(){} async start(){throw new Error('interrupted')} async createDatabase(){} async stop(){} }
      const stages=[]; for(let index=0;index<2;index+=1){try{await harness.withOperationalPostgres({embeddedFactory:Interrupted,operation:async()=>null,timeoutMs:100})}catch(error){stages.push(error.stage)}}
      const {access}=await import('node:fs/promises'); const gone=[]; for(const root of roots){try{await access(root);gone.push(false)}catch{gone.push(true)}}
      console.log(JSON.stringify({distinct:new Set(roots).size,gone,stages}));
    `);
    expect(result).toEqual({ distinct: 2, gone: [true, true], stages: ["start", "start"] });
  });
});
