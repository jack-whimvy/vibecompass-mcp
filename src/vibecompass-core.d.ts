declare module '@vibecompass/vibecompass' {
  export function loadProjectReadModel(rootDir: string): Promise<any>;
  export function getProjectContext(
    readModel: any,
    options?: { decisionLimit?: number; sessionLimit?: number },
  ): any;
  export function getFeatureContext(
    readModel: any,
    lookup: { featureKey: string },
  ): any;
  export function getDecisionLog(
    readModel: any,
    options?: { limit?: number },
  ): any;
  export function getFileContext(readModel: any, filepath: string): any;
  export function readBriefSettingsForRoot(rootDir: string): Promise<{
    enabled: boolean;
    enabledDeclared: boolean;
    exclude: string[];
    problems: string[];
    repos: unknown[];
  }>;
  export function buildSessionBrief(options: {
    rootDir: string;
    task?: string;
    files?: string[];
    featureSlugs?: string[];
    claims?: string[];
    laneId?: string;
    budget?: number;
  }): Promise<any>;
  export function renderBrief(result: any): string;
}
