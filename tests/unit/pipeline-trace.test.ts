/* @vitest-environment node */
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect,it } from 'vitest';
import { beginPipelineTrace,configurePipelineTrace,pipelineTrace } from '@main/diagnostics/pipeline-trace';
it('records monotonic stage and main-process CPU counters only when configured',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'meluli-trace-'));const file=join(directory,'events.jsonl');
 try{
  configurePipelineTrace(null);pipelineTrace('disabled','start');
  configurePipelineTrace(file);beginPipelineTrace();pipelineTrace('asr','start');pipelineTrace('asr','end');configurePipelineTrace(null);
  const rows=(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(rows.map(row=>row.stage)).toEqual(['pipeline','asr','asr']);expect(rows[1].operation).toBe(rows[2].operation);
  expect(BigInt(rows[2].atNs)).toBeGreaterThanOrEqual(BigInt(rows[1].atNs));
  expect(rows[2].mainCpuUserUs).toBeGreaterThanOrEqual(rows[1].mainCpuUserUs);expect(rows[2].mainCpuSystemUs).toBeGreaterThanOrEqual(rows[1].mainCpuSystemUs);
 }finally{configurePipelineTrace(null);await rm(directory,{recursive:true,force:true});}
});
