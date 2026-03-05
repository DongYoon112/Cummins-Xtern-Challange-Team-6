export type MissionStep = {
  id: string;
  name: string;
  toolHints?: string[];
};

export type MissionSpec = {
  objective: string;
  steps: MissionStep[];
  constraints: {
    budgetCap?: number;
    allowlistedSources?: string[];
    modelPolicy?: string;
  };
};
