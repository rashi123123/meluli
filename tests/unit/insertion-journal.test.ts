/* @vitest-environment node */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { InsertionJournal } from "@main/services/insertion-journal";
import { offlineResearchConfig } from "@main/services/offline-research-config";
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const id = "83b30250-4a91-4116-9f9b-b409c113a297";
it("reserves only one dispatch across concurrent requests and process restarts", async () => {
  const path = await mkdtemp(join(tmpdir(), "meluli-insertion-")); directories.push(path);
  const journal = new InsertionJournal(path);
  expect((await Promise.all(Array.from({ length: 20 }, () => journal.claim(id, "transcript")))).filter(Boolean)).toHaveLength(1);
  expect(await new InsertionJournal(path).claim(id, "another-transcript")).toBe(false);
  expect(JSON.parse(await readFile(join(path, id + ".json"), "utf8")).state).toBe("dispatch_reserved");
  await journal.settle(id, "transcript", "outcome_uncertain");
  expect(await journal.claim(id, "transcript")).toBe(false);
  expect(JSON.parse(await readFile(join(path, id + ".json"), "utf8")).automaticRetryAllowed).toBe(false);
});
it("fails closed on storage failure and rejects unsafe session paths", async () => {
  const journal = new InsertionJournal("/dev/null/research");
  await expect(journal.claim(id, "transcript")).rejects.toThrow();
  await expect(journal.settle("../escape", "transcript", "outcome_uncertain")).rejects.toThrow();
});
it('retains private recovery metadata on settlement and cannot overwrite a final receipt',async()=>{
 const path=await mkdtemp(join(tmpdir(),'meluli-recovery-'));directories.push(path);const journal=new InsertionJournal(path);
 await journal.claim(id,'pending-transcript');
 const recovery={transcriptText:'שלום GitHub',audioPath:'/isolated/session/original.pcm',evidencePath:'/isolated/evidence.json',target:{pid:123,bundleId:'local.editor',selectionStart:4}};
 await journal.attachRecovery(id,'transcript',recovery);await journal.settle(id,'transcript','unresolved');
 const receipt=JSON.parse(await readFile(join(path,id+'.json'),'utf8'));
 expect(receipt.recovery).toEqual(recovery);expect(receipt.automaticRetryAllowed).toBe(false);
 await expect(journal.settle(id,'transcript','confirmed')).rejects.toThrow();
 expect(JSON.parse(await readFile(join(path,id+'.json'),'utf8')).state).toBe('unresolved');
 await expect(new InsertionJournal(path).claim(id,'other')).resolves.toBe(false);
});
it('requires a durable claim and its owning transcript before attaching recovery',async()=>{
 const path=await mkdtemp(join(tmpdir(),'meluli-recovery-'));directories.push(path);const journal=new InsertionJournal(path);
 await expect(journal.settle(id,'t','confirmed')).rejects.toThrow();await journal.claim(id,'one');
 await expect(journal.settle(id,'two','confirmed')).rejects.toThrow();
});
it('forgets abandoned in-memory ownership while preserving a crash-safe no-retry reservation',async()=>{
 const path=await mkdtemp(join(tmpdir(),'meluli-abandoned-'));directories.push(path);const journal=new InsertionJournal(path);
 await journal.claim(id,'pending-transcript');journal.releaseOwnership(id);
 await expect(journal.settle(id,'pending-transcript','confirmed')).rejects.toThrow();
 expect(await new InsertionJournal(path).claim(id,'another')).toBe(false);
 expect(JSON.parse(await readFile(join(path,id+'.json'),'utf8')).state).toBe('dispatch_reserved');
});
it("keeps research absent by default and rejects packaged or ambiguous candidate selection", () => {
  expect(offlineResearchConfig(false, "/tmp/profile", {})).toBeNull();
  expect(() => offlineResearchConfig(true, "/tmp/profile", { MELULI_OFFLINE_RESEARCH: "q5-beam3" })).toThrow();
  expect(() => offlineResearchConfig(false, "/tmp/profile", { MELULI_OFFLINE_RESEARCH: "other" })).toThrow();
  expect(() => offlineResearchConfig(false, "/tmp/profile", { MELULI_OFFLINE_RESEARCH: "q5-beam3" })).toThrow();
});
