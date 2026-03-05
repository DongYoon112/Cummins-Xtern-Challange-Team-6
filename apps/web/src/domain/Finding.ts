export type Finding = {
  severity: "low" | "medium" | "high" | "critical";
  drivers?: string[];
  riskScore?: number;
  trend?: "up" | "down" | "flat";
};
