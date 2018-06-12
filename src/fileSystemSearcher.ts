
import * as path from 'path';
import * as vscode from 'vscode';

function joinPath(resource: vscode.Uri, pathFragment: string): vscode.Uri {
  const joinedPath = path.posix.join(resource.path || '/', pathFragment);
  return resource.with({
    path: joinedPath,
  });
}

function escapeRegExpCharacters(value: string): string {
  return value.replace(/[\-\\\{\}\*\+\?\|\^\$\.\[\]\(\)\#]/g, '\\$&');
}

export class FileSystemSearcher implements vscode.SearchProvider {
  constructor(public readonly provider: vscode.FileSystemProvider) {

  }

  public async provideTextSearchResults(query: vscode.TextSearchQuery, options: vscode.TextSearchOptions, progress: vscode.Progress<vscode.TextSearchResult>, token: vscode.CancellationToken): Promise<void> {
    const flags = query.isCaseSensitive ? 'g' : 'ig';
    let regexText = query.isRegExp ? query.pattern : escapeRegExpCharacters(query.pattern);
    if (query.isWordMatch) {
      regexText = `\\b${regexText}\\b`;
    }

    const searchRegex = new RegExp(regexText, flags);
    await this.textSearchDir(options.folder, '', searchRegex, options, progress, token);
  }

  public async provideFileSearchResults(options: vscode.SearchOptions, progress: vscode.Progress<string>, token: vscode.CancellationToken): Promise<void> {
    await this.fileSearchDir(options.folder, '', progress);
  }

  private async textSearchDir(baseFolder: vscode.Uri, relativeDir: string, pattern: RegExp, options: vscode.TextSearchOptions, progress: vscode.Progress<vscode.TextSearchResult>, token: vscode.CancellationToken): Promise<void> {
    const children = await this.provider.readDirectory(joinPath(baseFolder, relativeDir));
    if (token.isCancellationRequested) return;
    for (const [name, type] of children) {
      const relativeResult = path.posix.join(relativeDir, name);
      if (type === vscode.FileType.Directory) {
        await this.textSearchDir(baseFolder, relativeResult, pattern, options, progress, token);
      } else if (type === vscode.FileType.File) {
        await this.textSearchFile(baseFolder, relativeResult, pattern, options, progress);
      }
    }
  }

  private async textSearchFile(baseFolder: vscode.Uri, relativePath: string, pattern: RegExp, options: vscode.TextSearchOptions, progress: vscode.Progress<vscode.TextSearchResult>): Promise<void> {
    const fileUri = joinPath(baseFolder, relativePath);
    const fileContents = new Buffer(await this.provider.readFile(fileUri))
      .toString(options.encoding || 'utf8');

    fileContents
      .split(/\r?\n/)
      .forEach((line, i) => {
        let result: RegExpExecArray | null = pattern.exec(line);
        while (result) {
          const range = new vscode.Range(i, result.index, i, result.index + result[0].length);
          progress.report({
            range,
            path: relativePath,
            preview: {
              text: line,
              match: new vscode.Range(0, range.start.character, 0, range.end.character),
            },
          });
          result = pattern.exec(line);
        }
      });
  }

  private async fileSearchDir(folder: vscode.Uri, relativePath: string, progress: vscode.Progress<string>): Promise<void> {
    (await this.provider.readDirectory(joinPath(folder, relativePath)))
      .forEach(([name, type]) => {
        const relativeResult = path.posix.join(relativePath, name);
        if (type === vscode.FileType.Directory) {
          this.fileSearchDir(folder, relativeResult, progress);
        } else if (type === vscode.FileType.File) {
          progress.report(relativeResult);
        }
      });
  }

}

export default FileSystemSearcher;
