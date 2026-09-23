import { nowIso } from "../src/backend/lib/utils.js";
import { classifyPaper } from "../src/backend/services/classifier.js";
import { mutateDb } from "../src/backend/store/fileStore.js";

const focusDirection = process.argv[2] || "";

const result = await mutateDb((db) => {
  let changed = 0;
  let beforeFocus = 0;
  let afterFocus = 0;
  const changedPapers = [];

  for (const paper of db.papers) {
    const beforeDirections = [paper.primaryDirection, ...(paper.secondaryDirections || [])].filter(Boolean);
    if (focusDirection && beforeDirections.includes(focusDirection)) beforeFocus += 1;

    const classification = classifyPaper(paper);
    const afterDirections = [classification.primaryDirection, ...(classification.secondaryDirections || [])].filter(Boolean);
    if (focusDirection && afterDirections.includes(focusDirection)) afterFocus += 1;

    const didChange = [
      "hcaiScore",
      "primaryDirection",
      "reviewStatus",
      "confidence",
      "classificationReason"
    ].some((field) => paper[field] !== classification[field])
      || JSON.stringify(paper.secondaryDirections || []) !== JSON.stringify(classification.secondaryDirections || [])
      || JSON.stringify(paper.researchQuestions || []) !== JSON.stringify(classification.researchQuestions || [])
      || JSON.stringify(paper.researchMethods || []) !== JSON.stringify(classification.researchMethods || [])
      || JSON.stringify(paper.applicationContexts || []) !== JSON.stringify(classification.applicationContexts || [])
      || JSON.stringify(paper.userGroups || []) !== JSON.stringify(classification.userGroups || [])
      || JSON.stringify(paper.aiSystemTypes || []) !== JSON.stringify(classification.aiSystemTypes || [])
      || JSON.stringify(paper.interactionModes || []) !== JSON.stringify(classification.interactionModes || [])
      || JSON.stringify(paper.evaluationMetrics || []) !== JSON.stringify(classification.evaluationMetrics || [])
      || JSON.stringify(paper.contributionTypes || []) !== JSON.stringify(classification.contributionTypes || []);

    if (!didChange) continue;
    Object.assign(paper, classification, { updatedAt: nowIso() });
    changed += 1;
    changedPapers.push({
      id: paper.id,
      title: paper.title,
      beforeDirections,
      afterDirections
    });
  }

  db.meta.lastUpdateAt = nowIso();
  return {
    total: db.papers.length,
    changed,
    focusDirection: focusDirection || undefined,
    beforeFocus: focusDirection ? beforeFocus : undefined,
    afterFocus: focusDirection ? afterFocus : undefined,
    changedPapers: changedPapers.slice(0, 20)
  };
});

console.log(JSON.stringify(result, null, 2));
