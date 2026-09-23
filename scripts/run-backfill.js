import { runUpdateJob } from "../src/backend/services/updateJob.js";

const days = Number(process.argv[2] || 365);
const maxCandidates = Number(process.argv[3] || 800);
const directionId = process.argv[4] || undefined;

const log = await runUpdateJob({
  source: directionId ? `cli-backfill-${days}d-${directionId}` : `cli-backfill-${days}d`,
  windowHours: days * 24,
  deep: true,
  maxCandidates,
  directionId
});

console.log(JSON.stringify(log, null, 2));
