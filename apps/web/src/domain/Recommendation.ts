export type RecommendationAction = {
  actionId: string;
  title: string;
  evidence_refs?: string[];
};

export type Recommendation = {
  summary?: string;
  actions: RecommendationAction[];
};
