export interface EnvironmentConfig {
  source: string;
  shared: string;
  modelGateway: string;
  workerImage: string;
  databaseImage: string;
}
export interface Environment {
  taskId: string;
  attemptId: string;
  owner: string;
  status: 'preparing' | 'ready' | 'failed';
  stage: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  root: string;
  worktree: string;
  branch: string;
  base: string;
  config: EnvironmentConfig;
  profileHash: string;
  model: string;
  gatewayIdentity?: string;
  volumeIdentity?: string;
  filesystem?: { device: number; inode: number };
  resources: {
    databaseName: string;
    workerName: string;
    volumeName: string;
    databaseId?: string;
    workerId?: string;
  };
  database?: Record<string, unknown>;
  ports: { application: number; postgres: number; model: number };
}
