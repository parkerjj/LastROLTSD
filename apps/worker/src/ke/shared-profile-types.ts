export interface ProfileSharingInput {
  enabled: boolean;
  description?: string;
}
export interface ProfileSharingMetadata {
  id: number;
  share_code: string;
  status: 'PUBLISHED' | 'WITHDRAWN';
  updated_at: number;
  description?: string;
}
export interface SharedProfileSummary {
  id: number;
  title: string;
  description: string;
  job_id: number | null;
  author: { id: string; display_name: string };
  share_code: string;
  like_count: number;
  use_count: number;
  liked_by_me: boolean;
  used_by_me: boolean;
  is_mine: boolean;
  created_at: number;
  updated_at: number;
}
export interface SharedProfileDetail extends SharedProfileSummary {
  config_text: string;
  mon_control: string | null;
  pickupitems: string | null;
  items_control: string | null;
  timeouts: string | null;
}
export interface SharedProfileQuery {
  sort: 'newest' | 'uses' | 'likes';
  page: number;
  job_id?: number;
  job_ids?: number[];
}
export interface SharedProfilePage {
  items: SharedProfileSummary[];
  page: number;
  page_size: 20;
  total: number;
}
export interface SharedProfileCopyInput {
  aid: number;
  cid: number;
  nid: number;
  request_id: string;
}
export interface SharedProfileCopyResult {
  profile_id: number;
  name: string;
  use_count: number;
  duplicate: boolean;
}
