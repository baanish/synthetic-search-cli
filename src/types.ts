export type SyntheticSearchResult = {
  url: string;
  title: string;
  text: string;
  published: string | null;
};

export type SyntheticSearchResponse = {
  results?: unknown;
};

export type SyntheticQuotas = {
  limit: number;
  requestsUsed: number;
  remaining: number;
  renewsAt: string | null;
};

export type CredentialSource = "env" | "config" | "none";

export type ResolvedCredentials = {
  source: CredentialSource;
  apiKey: string | null;
};
