export interface HallJobFamily {
  value: string;
  label: string;
  category: string;
  job_ids: number[];
}

export function buildHallJobFamilies(jobs: Record<string, string>): HallJobFamily[];
