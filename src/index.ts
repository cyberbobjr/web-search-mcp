#!/usr/bin/env node
console.error('Web Search MCP Server starting...');

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SearchEngine } from './search-engine.js';
import { EnhancedContentExtractor } from './enhanced-content-extractor.js';
import { DiskCache, createDefaultCache } from './cache.js';
import { WebSearchToolInput, WebSearchToolOutput, SearchResult, ContentExtractionOptions } from './types.js';
import { isPdfUrl } from './utils.js';
import { assertSafeUrl } from './url-guard.js';

function readPackageVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Shared Zod schemas — defined once, referenced by name in tool registrations.
// Using simple types keeps TypeScript inference shallow (avoids TS2589 with deep Zod transforms).
const fullWebSearchSchema = {
  query: z.string().describe('Search query to execute (recommended for comprehensive research)'),
  limit: z.number().min(1).max(10).optional().describe('Number of results to return with full content (1-10, default 5)'),
  includeContent: z.boolean().optional().describe('Whether to fetch full page content (default: true)'),
  maxContentLength: z.number().min(0).optional().describe('Maximum characters per result content (0 = no limit). Usually not needed - content length is automatically optimized.'),
};

const getWebSearchSummariesSchema = {
  query: z.string().describe('Search query to execute (lightweight alternative)'),
  limit: z.number().min(1).max(10).optional().describe('Number of search results to return (1-10, default 5)'),
};

const getSingleWebPageSchema = {
  url: z.string().url().describe('The URL of the web page to extract content from'),
  maxContentLength: z.number().min(0).optional().describe('Maximum characters for the extracted content (0 = no limit, undefined = use default limit). Usually not needed - content length is automatically optimized.'),
};

const clearCacheSchema = {};

class WebSearchMCPServer {
  private server: McpServer;
  private searchEngine: SearchEngine;
  private contentExtractor: EnhancedContentExtractor;
  private cache: DiskCache;

  constructor() {
    this.server = new McpServer({
      name: 'web-search-mcp',
      version: readPackageVersion(),
    });

    this.searchEngine = new SearchEngine();
    this.contentExtractor = new EnhancedContentExtractor();
    this.cache = createDefaultCache();

    this.setupTools();
    this.setupGracefulShutdown();
  }

  private setupTools(): void {
    // Register the main web search tool (primary choice for comprehensive searches)
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore TS2589: SDK type inference is too deep with complex Zod chains
    this.server.tool(
      'full-web-search',
      'Search the web and fetch complete page content from top results. This is the most comprehensive web search tool. It searches the web and then follows the resulting links to extract their full page content, providing the most detailed and complete information available. Use get-web-search-summaries for a lightweight alternative.',
      fullWebSearchSchema,
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore TS2589: SDK type inference is too deep with complex Zod chains
      async (args: unknown) => {
        console.error(`[MCP] Tool call received: full-web-search`);

        try {
          const typedArgs = args as WebSearchToolInput;
          const result = await this.handleWebSearch(typedArgs);

          console.error(`[MCP] Search completed, found ${result.results.length} results`);

          // Format the results as a comprehensive text response
          let responseText = `Search completed for "${result.query}" with ${result.total_results} results:\n\n`;

          if (result.status) {
            responseText += `**Status:** ${result.status}\n\n`;
          }

          const maxLength = typedArgs.maxContentLength;

          result.results.forEach((searchResult, idx) => {
            responseText += `**${idx + 1}. ${searchResult.title}**\n`;
            responseText += `URL: ${searchResult.url}\n`;
            responseText += `Description: ${searchResult.description}\n`;

            if (searchResult.fullContent && searchResult.fullContent.trim()) {
              let content = searchResult.fullContent;
              if (maxLength && maxLength > 0 && content.length > maxLength) {
                content = content.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} characters]`;
              }
              responseText += `\n**Full Content:**\n${content}\n`;
            } else if (searchResult.contentPreview && searchResult.contentPreview.trim()) {
              let content = searchResult.contentPreview;
              if (maxLength && maxLength > 0 && content.length > maxLength) {
                content = content.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} characters]`;
              }
              responseText += `\n**Content Preview:**\n${content}\n`;
            } else if (searchResult.fetchStatus === 'error') {
              responseText += `\n**Content Extraction Failed:** ${searchResult.error}\n`;
            }

            responseText += `\n---\n\n`;
          });

          return {
            content: [
              {
                type: 'text' as const,
                text: responseText,
              },
            ],
          };
        } catch (error) {
          console.error(`[MCP] Error in full-web-search handler:`, error);
          throw error;
        } finally {
          try {
            await Promise.all([
              this.searchEngine.closeAll(),
              this.contentExtractor.closeAll(),
            ]);
          } catch (cleanupError) {
            console.error(`[MCP] Error during browser cleanup:`, cleanupError);
          }
        }
      }
    );

    // Register the lightweight web search summaries tool (secondary choice for quick results)
    this.server.tool(
      'get-web-search-summaries',
      'Search the web and return only the search result snippets/descriptions without following links to extract full page content. This is a lightweight alternative to full-web-search for when you only need brief search results. For comprehensive information, use full-web-search instead.',
      getWebSearchSummariesSchema,
      async (args: unknown) => {
        console.error(`[MCP] Tool call received: get-web-search-summaries`);

        try {
          const typedArgs = args as { query: string; limit: number };
          const numResults = typedArgs.limit ?? 5;
          const searchCacheKey = { query: typedArgs.query, numResults };

          let searchResponse = await this.cache.get<Awaited<ReturnType<SearchEngine['search']>>>('search', searchCacheKey);
          if (searchResponse) {
            console.error(`[MCP] Cache hit: search for "${typedArgs.query}"`);
          } else {
            searchResponse = await this.searchEngine.search({ query: typedArgs.query, numResults });
            if (searchResponse.results.length > 0) {
              await this.cache.set('search', searchCacheKey, searchResponse);
            }
          }

          const baseResults = searchResponse.results.map(item => ({
            title: item.title,
            url: item.url,
            description: item.description,
            timestamp: item.timestamp,
          }));

          // Enrich each result with a lightweight content preview (axios only, no browser)
          const PREVIEW_MAX_CHARS = 1500;
          const PREVIEW_TIMEOUT_MS = 4000;

          const previews = await Promise.allSettled(
            baseResults.map(item =>
              this.extractContentCached({
                url: item.url,
                timeout: PREVIEW_TIMEOUT_MS,
                maxContentLength: PREVIEW_MAX_CHARS,
                axiosOnly: true,
              })
            )
          );

          const summaryResults = baseResults.map((item, i) => {
            const previewResult = previews[i];
            const preview =
              previewResult.status === 'fulfilled' && previewResult.value.trim().length > 0
                ? previewResult.value.trim()
                : null;
            return { ...item, preview };
          });

          console.error(`[MCP] Search summaries completed, found ${summaryResults.length} results`);

          let responseText = `Search summaries for "${typedArgs.query}" with ${summaryResults.length} results:\n\n`;

          summaryResults.forEach((summary, i) => {
            responseText += `**${i + 1}. ${summary.title}**\n`;
            responseText += `URL: ${summary.url}\n`;
            responseText += `Description: ${summary.description}\n`;
            if (summary.preview) {
              responseText += `Preview:\n${summary.preview}\n`;
            }
            responseText += `\n---\n\n`;
          });

          return {
            content: [
              {
                type: 'text' as const,
                text: responseText,
              },
            ],
          };
        } catch (error) {
          console.error(`[MCP] Error in get-web-search-summaries handler:`, error);
          throw error;
        } finally {
          try {
            await this.searchEngine.closeAll();
          } catch (cleanupError) {
            console.error(`[MCP] Error during browser cleanup:`, cleanupError);
          }
        }
      }
    );

    // Register the cache management tool
    this.server.tool(
      'clear-cache',
      'Flush all cached search results and extracted page content from disk. Returns the number of cache entries deleted. Use this when you want to force fresh results instead of serving cached data.',
      clearCacheSchema,
      async () => {
        console.error(`[MCP] Tool call received: clear-cache`);
        const count = await this.cache.clearAll();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Cache cleared: ${count} ${count === 1 ? 'entry' : 'entries'} removed.`,
            },
          ],
        };
      }
    );

    // Register the single page content extraction tool
    this.server.tool(
      'get-single-web-page-content',
      'Extract and return the full content from a single web page URL. This tool follows a provided URL and extracts the main page content. Useful for getting detailed content from a specific webpage without performing a search.',
      getSingleWebPageSchema,
      async (args: unknown) => {
        console.error(`[MCP] Tool call received: get-single-web-page-content`);

        try {
          const typedArgs = args as { url: string; maxContentLength?: number };
          // SSRF protection: validate URL before fetching
          await assertSafeUrl(typedArgs.url);

          // If maxContentLength is 0, treat it as "no limit" (undefined)
          const maxContentLength = typedArgs.maxContentLength === 0 ? undefined : typedArgs.maxContentLength;

          console.error(`[MCP] Starting single page content extraction for: ${typedArgs.url}`);

          const content = await this.extractContentCached({
            url: typedArgs.url,
            maxContentLength,
          });

          const urlObj = new URL(typedArgs.url);
          const title = urlObj.hostname + urlObj.pathname;

          const wordCount = content.split(/\s+/).filter(word => word.length > 0).length;

          console.error(`[MCP] Extracted ${content.length} characters from: ${typedArgs.url}`);

          let responseText = `**Page Content from: ${typedArgs.url}**\n\n`;
          responseText += `**Title:** ${title}\n`;
          responseText += `**Word Count:** ${wordCount}\n`;
          responseText += `**Content Length:** ${content.length} characters\n\n`;

          if (maxContentLength && maxContentLength > 0 && content.length > maxContentLength) {
            responseText += `**Content (truncated at ${maxContentLength} characters):**\n${content.substring(0, maxContentLength)}\n\n[Content truncated at ${maxContentLength} characters]`;
          } else {
            responseText += `**Content:**\n${content}`;
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: responseText,
              },
            ],
          };
        } catch (error) {
          console.error(`[MCP] Error in get-single-web-page-content handler:`, error);
          throw error;
        }
      }
    );
  }

  private async handleWebSearch(input: WebSearchToolInput): Promise<WebSearchToolOutput> {
    const startTime = Date.now();
    const { query, limit = 5, includeContent = true } = input;

    console.error(`[web-search-mcp] handleWebSearch: limit=${limit}, includeContent=${includeContent}`);

    try {
      // Request extra results to account for potential PDF files that will be skipped
      const searchLimit = includeContent ? Math.min(limit * 2 + 2, 10) : limit;

      const searchCacheKey = { query, numResults: searchLimit };
      let searchResponse = await this.cache.get<Awaited<ReturnType<SearchEngine['search']>>>('search', searchCacheKey);
      if (searchResponse) {
        console.error(`[MCP] Cache hit: search for "${query}"`);
      } else {
        searchResponse = await this.searchEngine.search({ query, numResults: searchLimit });
        if (searchResponse.results.length > 0) {
          await this.cache.set('search', searchCacheKey, searchResponse);
        }
      }
      const searchResults = searchResponse.results;

      const pdfCount = searchResults.filter(result => isPdfUrl(result.url)).length;
      const followedCount = searchResults.length - pdfCount;
      console.error(`[web-search-mcp] Engine: ${searchResponse.engine}; requested=${limit}, obtained=${searchResults.length}, PDF=${pdfCount}, followed=${followedCount}`);

      const enhancedResults = includeContent
        ? await this.contentExtractor.extractContentForResults(searchResults, limit)
        : searchResults.slice(0, limit);

      let combinedStatus = `Search engine: ${searchResponse.engine}; ${limit} result requested/${searchResults.length} obtained; PDF: ${pdfCount}; ${followedCount} followed`;

      if (includeContent) {
        const successCount = enhancedResults.filter(r => r.fetchStatus === 'success').length;
        const failedResults = enhancedResults.filter(r => r.fetchStatus === 'error');
        const failedCount = failedResults.length;

        const failureReasons = this.categorizeFailureReasons(failedResults);
        const failureReasonText = failureReasons.length > 0 ? ` (${failureReasons.join(', ')})` : '';

        console.error(`[web-search-mcp] Extracted: ${successCount} ok, ${failedCount} failed${failureReasonText}`);
        combinedStatus += `; Successfully extracted: ${successCount}; Failed: ${failedCount}; Results: ${enhancedResults.length}`;
      }

      return {
        results: enhancedResults,
        total_results: enhancedResults.length,
        search_time_ms: Date.now() - startTime,
        query,
        status: combinedStatus,
      };
    } catch (error) {
      console.error('Web search error:', error);
      throw new Error(`Web search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /** Extracts page content with disk-cache read-through. */
  private async extractContentCached(options: ContentExtractionOptions): Promise<string> {
    const cacheKey = {
      url: options.url,
      maxContentLength: options.maxContentLength ?? null,
      axiosOnly: options.axiosOnly ?? false,
    };
    const cached = await this.cache.get<string>('content', cacheKey);
    if (cached !== null) {
      console.error(`[MCP] Cache hit: content for ${options.url}`);
      return cached;
    }
    const content = await this.contentExtractor.extractContent(options);
    if (content.trim().length > 0) {
      await this.cache.set('content', cacheKey, content);
    }
    return content;
  }

  private categorizeFailureReasons(failedResults: SearchResult[]): string[] {
    const reasonCounts = new Map<string, number>();

    failedResults.forEach(result => {
      if (result.error) {
        const category = this.categorizeError(result.error);
        reasonCounts.set(category, (reasonCounts.get(category) || 0) + 1);
      }
    });

    return Array.from(reasonCounts.entries()).map(([reason, count]) =>
      count > 1 ? `${reason} (${count})` : reason
    );
  }

  private categorizeError(errorMessage: string): string {
    const lowerError = errorMessage.toLowerCase();

    if (lowerError.includes('timeout') || lowerError.includes('timed out')) return 'Timeout';
    if (lowerError.includes('403') || lowerError.includes('forbidden')) return 'Access denied';
    if (lowerError.includes('404') || lowerError.includes('not found')) return 'Not found';
    if (lowerError.includes('bot') || lowerError.includes('captcha') || lowerError.includes('unusual traffic')) return 'Bot detection';
    if (lowerError.includes('too large') || lowerError.includes('content length') || lowerError.includes('maxcontentlength')) return 'Content too long';
    if (lowerError.includes('ssl') || lowerError.includes('certificate') || lowerError.includes('tls')) return 'SSL error';
    if (lowerError.includes('network') || lowerError.includes('connection') || lowerError.includes('econnrefused')) return 'Network error';
    if (lowerError.includes('dns') || lowerError.includes('hostname')) return 'DNS error';

    return 'Other error';
  }

  private setupGracefulShutdown(): void {
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
    });

    const shutdown = async () => {
      console.error('Shutting down gracefully...');
      try {
        await Promise.all([
          this.contentExtractor.closeAll(),
          this.searchEngine.closeAll(),
        ]);
      } catch (error) {
        console.error('Error during graceful shutdown:', error);
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Web Search MCP Server started');
  }
}

// Start the server
const server = new WebSearchMCPServer();
server.run().catch((error: unknown) => {
  console.error('Server error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
