import type { GenerateInput, Job } from './index';

export interface ComparisonChildQuote {
  input: GenerateInput;
  endpointRegion: string;
  providerId: string;
  estimatedMicros: number;
  ceilingMicros: number;
  notices: string[];
}

export interface ComparisonQuote {
  children: [ComparisonChildQuote, ComparisonChildQuote];
  estimatedMicros: number;
  ceilingMicros: number;
}

export interface ComparisonJob extends Job {
  executionTiming: { durationMs: number; source: 'gateway' | 'provider' } | null;
}

export interface ComparisonRun extends ComparisonQuote {
  id: string;
  expiresAt: string;
  admittedAt: string | null;
  jobs: ComparisonJob[];
}

export interface ComparisonSummary {
  id: string;
  admittedAt: string;
  routeIds: [string, string];
}
