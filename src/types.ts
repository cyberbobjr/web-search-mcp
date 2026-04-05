export interface SearchResult {
  title: string;
  url: string;
  description: string;
  fullContent: string;
  contentPreview: string;
  wordCount: number;
  timestamp: string;
  fetchStatus: 'success' | 'error' | 'timeout';
  error?: string;
}

export interface SearchResponse {
  query: string;
  limit: number;
  results: SearchResult[];
  totalFound: number;
  searchTimestamp: string;
  processingTimeMs: number;
}

export interface SearchOptions {
  query: string;
  numResults?: number;
  timeout?: number;
}

export interface ContentExtractionOptions {
  url: string;
  timeout?: number;
  maxContentLength?: number;
  axiosOnly?: boolean;
}

export interface WebSearchToolInput {
  query: string;
  limit?: number;
  includeContent?: boolean;
  maxContentLength?: number;
}

export interface WebSearchToolOutput {
  results: SearchResult[];
  total_results: number;
  search_time_ms: number;
  query: string;
  status?: string;
}

// Search result with metadata about which search engine was used
export interface SearchResultWithMetadata {
  results: SearchResult[];
  engine: string;
}
