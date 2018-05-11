
import { CancellationToken, FileSystemProvider, Progress, SearchProvider, TextSearchOptions, TextSearchQuery, TextSearchResult, Uri } from 'vscode';

export class FileSystemSearcher implements SearchProvider {
  constructor(public readonly provider: FileSystemProvider) {

  }
  /* SearchProvider */
  public async provideFileSearchResults(query: string, progress: Progress<Uri>, token: CancellationToken): Promise<void> {

  }
  public async provideTextSearchResults(query: TextSearchQuery, options: TextSearchOptions, progress: Progress<TextSearchResult>, token: CancellationToken): Promise<void> {

  }
}

export default FileSystemSearcher;
