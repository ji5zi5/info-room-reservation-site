import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function runCore(source: string): unknown {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import * as core from './scripts/operational-fomo-core.mjs';
    ${source}
  `], { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? "null");
}

describe("operational FOMO portable core", () => {
  it("exists as a tracked clean-clone entry point independent of .omo", async () => {
    await expect(access(join(process.cwd(), "scripts", "operational-fomo-core.mjs"))).resolves.toBeUndefined();
  });

  it("rejects misleading success output when the child exits nonzero", async () => {
    const result = runCore(`try { await core.runChildCommand(process.execPath,['-e',"console.log('PASS');process.exit(7)"],{timeoutMs:1000}); } catch(error){console.log(JSON.stringify({exitCode:error.details.exitCode,hasPass:error.details.stdout.includes('PASS')}))}`);
    expect(result).toEqual({ exitCode: 7, hasPass: true });
  });

  it("rejects a hung child at the configured deadline", async () => {
    const result = runCore(`
      import {readFileSync,rmSync} from 'node:fs'; import {join} from 'node:path'; import {tmpdir} from 'node:os';
      const marker=join(tmpdir(),'fomo-child-'+process.pid); const program="const{spawn}=require('node:child_process'),fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)";
      let failure; try { await core.runChildCommand(process.execPath,['-e',program,marker],{timeoutMs:300}); } catch(error){failure=error}
      const pid=Number(readFileSync(marker,'utf8')); rmSync(marker); let alive=true; try { process.kill(pid,0) } catch { alive=false }
      console.log(JSON.stringify({alive,name:failure.name,message:failure.message}));
    `);
    expect(result).toEqual({ alive: false, message: "child command timed out", name: "OperationalChildError" });
  });

  it("fails closed for Discord and browser phases that later todos own", () => {
    const result = runCore(`
      const phases=[];
      for (const phase of ['discord','browser']) { try { await core.runOperationalCore({phase}); } catch(error) { phases.push({name:error.name,phase:error.phase}); } }
      console.log(JSON.stringify(phases));
    `);
    expect(result).toEqual([
      { name: "OperationalPrerequisiteError", phase: "discord" },
      { name: "OperationalPrerequisiteError", phase: "browser" }
    ]);
  });

  it("reports missing Chromium as a typed prerequisite failure", () => {
    const result = runCore(`
      try { await core.requireChromium(async()=>{throw new Error('missing')},'missing-playwright.js'); }
      catch(error){console.log(JSON.stringify({name:error.name,stage:error.stage}))}
    `);
    expect(result).toEqual({ name: "OperationalHarnessError", stage: "chromium" });
  });
});
