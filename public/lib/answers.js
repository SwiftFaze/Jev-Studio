// Small helpers for reading System One answers.

export const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * 0..1: how decisive an answer is. Choice and Score use Jev's own confidence.
 * Yes / No has no separate confidence, so use distance from 50/50 (0.5 -> 0, 0 or 1 -> 1).
 */
export function certainty(answer) {
  if (!answer) return null;
  // Rounded so that a probability of 0.95 is exactly 0.9 certain, not 0.8999999999999999: the review slider works in whole
  // percentages, and an answer must not fall a hair short of the line it displays as meeting.
  if (answer.type === 'noul') return clamp01(Math.round(Math.abs(answer.noul - 0.5) * 2 * 1e9) / 1e9);
  return typeof answer.confidence === 'number' ? clamp01(answer.confidence) : null;
}

export const levelCount = (question) => (Array.isArray(question?.criteria) ? question.criteria.length : 0);

export const nearestLevel = (score, count) => Math.max(0, Math.min(count - 1, Math.round(score)));

export function answerLabel(answer) {
  switch (answer?.type) {
    case 'noul':
      return answer.noul >= 0.5 ? 'Yes' : 'No';
    case 'choice':
      return answer.choice;
    case 'score':
      return answer.score.toFixed(2);
    default:
      return '';
  }
}
