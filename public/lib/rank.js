// Ranking is the batch engine pointed at a fixed pair of questions: each candidate is judged against the query,
// then a weighted composite orders them. Jev returns scores, not text, so this ranks by probability-weighted relevance.

export function rankQuestions() {
  return {
    relevance: {
      type: 'score',
      instructions: 'How relevant is the Candidate to the Query?',
      criteria: [
        'Unrelated: shares no topic with the query',
        'Loosely related: same general area but does not help with the query',
        'Relevant: addresses the query but only partly or indirectly',
        'Highly relevant: directly and fully addresses the query',
      ],
    },
    answers_query: {
      type: 'noul',
      instructions: 'Does the Candidate directly answer or satisfy the Query?',
      criteria: {
        true: 'The candidate contains what the query asks for',
        false: 'The candidate does not contain what the query asks for',
      },
    },
  };
}

export const rankSpecs = () => ({
  relevance: { enabled: true, weight: 70, invert: false, target: null },
  answers_query: { enabled: true, weight: 30, invert: false, target: null },
});

export const buildRankState = (query, candidate) => `Query: ${query.trim()}\n\nCandidate: ${candidate.trim()}`;
