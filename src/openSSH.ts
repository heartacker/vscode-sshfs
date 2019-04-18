import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toPromise } from './toPromise';

/** Config options that can be set both in the global config and per host */
export interface CommonConfig {
  /** Which identityAgent to use. Can contain environment variables. Can be false for explicitly none */
  identityAgent?: string | false;
  /** List of private keys to try authenticating with */
  identityFiles: string[];
  /** The hostname set for this config */
  hostname?: string;
  /** The username set for this config */
  user?: string;
  /** The port set for this config */
  port?: number;
}

/** Config options that can only be set in the global config */
export interface GlobalConfig extends CommonConfig {
  /** List of configs declared in this global config */
  configs: (HostConfig | MatchConfig)[];
}

/** Config options for a host declared by a Host keyword */
export interface HostConfig extends CommonConfig {
  /** List of tuples, each representing a host (pattern) and whether it's negated */
  hosts: [string, boolean][];
}

/** Config options for a host declared by a Match keyword */
export interface MatchConfig extends CommonConfig {
  /** List of matches defined for this host */
  matches: Match[];
}

/** Calculated options, with references to the matched Host/Match configs */
export interface CalculatedConfig extends CommonConfig {
  matched: (HostConfig | MatchConfig)[];
}

const NOOP = () => false; // Lots of things aren't supported (yet)
export const MATCH_KEYWORDS = {
  all: [false, () => true],
  canonical: [false, NOOP],
  final: [false, NOOP],
  exec: [true, NOOP],
  host: [true],
  originalhost: [true],
  user: [true],
  localuser: [true],
} as const;

export interface Match {
  type: keyof typeof MATCH_KEYWORDS;
  negated: boolean;
  value?: string;
}

interface Execution {
  global: GlobalConfig;
  current: HostConfig | MatchConfig | null;
  basepath: string;
}

type KeywordHandler = (rest: string[], exec: Execution) => Promise<void> | void;
const KEYWORDS: { [key: string]: KeywordHandler } = {
  async host(rest, exec) {
    const newConfig: HostConfig = {
      hosts: rest.map(s => s.startsWith('!') ? [s.substr(1), true] : [s, false]),
      identityFiles: [],
    };
    exec.global.configs.push(newConfig);
    exec.current = newConfig;
  },
  async match(rest, exec) {
    const matches: Match[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      let keyword = rest[i].toLowerCase() as keyof typeof MATCH_KEYWORDS;
      const negated = keyword.startsWith('!');
      if (negated) keyword = keyword.substr(1) as any;
      const mat = MATCH_KEYWORDS[keyword];
      if (!mat) throw new Error(`Unknown keyword "${keyword}" in Match statement`);
      if (mat[0]) i += 1;
      const value = mat[0] ? rest[i] : undefined;
      matches.push({ negated, value, type: keyword });
    }
    const newConfig: MatchConfig = { matches, identityFiles: [] };
    exec.global.configs.push(newConfig);
    exec.current = newConfig;
  },
  async hostname(rest, { current }) {
    if (rest.length !== 1) throw new Error('Keyword Hostname requires exactly 1 argument');
    if (!current) throw new Error('Keyword Hostname used outside a config');
    current.hostname = current.hostname || rest[0];
  },
  async identityagent(rest, { current }) {
    if (rest.length !== 1) throw new Error('Keyword IdentityAgent requires exactly 1 argument');
    if (!current) throw new Error('Keyword IdentityAgent used outside a config');
    if (current.identityAgent !== undefined) return;
    if (rest[0].toLowerCase() === 'none') {
      current.identityAgent = false;
    } else if (rest[0] === 'SSH_AUTH_SOCK') {
      current.identityAgent = '$SSH_AUTH_SOCK';
    } else {
      current.identityAgent = rest[0];
    }
  },
  async identityfile(rest, { global, current }) {
    if (rest.length !== 1) throw new Error('Keyword IdentityFile requires exactly 1 argument');
    (current || global).identityFiles.push(rest[0]);
  },
  async include(rest, exec) {
    for (const includePath of rest) {
      const parsedPath = path.parse(includePath);
      let { dir, base: file } = parsedPath;
      if (dir.startsWith('~')) {
        dir = path.join(os.homedir(), dir);
      } else if (!parsedPath.root) {
        dir = path.join(exec.basepath, dir);
      }
      file = path.join(dir, file);
      const content = await toPromise<Buffer>(cb => fs.readFile(includePath, cb))
        .catch(() => { throw new Error(`Couldn't read Include file: ${includePath} (resolved to ${file})`); });
      await parseConfig(content.toString(), { ...exec, basepath: dir }).catch((e: Error) => {
        e.message = `Error in ${file}: ${e.message}`;
        throw e;
      });
    }
  },
  async port(rest, exec) {
    if (rest.length !== 1) throw new Error('Keyword Port requires exactly 1 argument');
    if (!Number(rest[0])) throw new Error('Keyword Port expects a number as argument');
    const conf = (exec.current || exec.global);
    conf.port = conf.port || Number(rest[0]);
  },
  async user(rest, exec) {
    if (rest.length !== 1) throw new Error('Keyword User requires exactly 1 argument');
    const conf = (exec.current || exec.global);
    conf.user = conf.user || rest[0];
  },
  // TODO: PreferredAuthentications, ProxyCommand, ProxyJump, StrictHostKeyChecking, UserKnownHostsFile
};

function splitArguments(str: string): string[] {
  str = str.trim();
  if (!str) return [];
  if (str.startsWith('"')) {
    const next = str.indexOf('"', 1);
    if (next === -1) throw new Error('Unfinished quote');
    if (str[next + 1] && !str[next + 1].match(/\s/)) throw new Error('End quote should be followed by whitespace/nothing');
    return [str.substr(0, next), ...splitArguments(str.substr(next + 1))];
  }
  const [mat] = str.match(/^\S+/)!;
  if (mat.includes('"')) throw new Error('Begin quote should be after whitespace/nothing');
  return [mat, ...splitArguments(str.substr(mat.length))];
}

export async function parseConfig(content: string, exec: Execution): Promise<void> {
  let lineNumber = 0;
  for (let line of content.split('\n')) {
    lineNumber += 1;
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const [, keyword, rest] = line.match(/^(\w+)$/) || line.match(/^(\w+)(?:\s*=\s*|\s+)(.*)$/) || ['', '', ''];
    if (!keyword) throw new Error(`Error on line ${lineNumber}: Invalid syntax`);
    const handler = KEYWORDS[keyword.toLowerCase()];
    if (!handler) continue;
    try {
      await handler(splitArguments(rest), exec);
    } catch (e) {
      e.message = `Error on line ${lineNumber}: ${e.message}`;
      throw e;
    }
  }
}

export async function parseConfigFile(filepath: string): Promise<GlobalConfig> {
  const global: GlobalConfig = { configs: [], identityFiles: [] };
  const basepath = path.dirname(filepath);
  const exec: Execution = { global, basepath, current: null };
  const content = await toPromise<Buffer>(cb => fs.readFile(filepath, cb))
    .catch(() => { throw new Error(`Couldn't read file: ${filepath}`); });
  let lineNumber = 0;
  for (let line of content.toString().split('\n')) {
    lineNumber += 1;
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const [, keyword, rest] = line.match(/^(\w+)$/) || line.match(/^(\w+)(?:\s*=\s*|\s+)(.*)$/) || ['', '', ''];
    if (!keyword) throw new Error(`Error on line ${lineNumber}: Invalid syntax`);
    const handler = KEYWORDS[keyword.toLowerCase()];
    if (!handler) continue;
    try {
      await handler(splitArguments(rest), exec);
    } catch (e) {
      e.message = `Error on line ${lineNumber}: ${e.message}`;
      throw e;
    }
  }
  return global;
}

function applyTokens(input: string, tokens: { [token: string]: any }): string {
  return input.replace(/%(.)/g, (_, c) => c in tokens ? `${tokens[c]}` : `%${c}`);
}

function fitsPattern(input: string, pattern: string): boolean {
  const replacer = (ch: string) => ch === '*' ? '.*' :
    ch === '?' ? '.' : ch === '\\' ? '\\\\' : ch;
  pattern = `^${pattern.replace(/./g, replacer)}$`;
  const regexp = new RegExp(pattern, 'i');
  return regexp.test(input);
}

function fitsPatterns(input: string, patterns: [string, boolean][]): boolean {
  let fits = false;
  for (const [pattern, negates] of patterns) {
    if (fitsPattern(input, pattern)) {
      if (negates) return false;
      fits = true;
    }
  }
  return fits;
}

function fitsMatches({ hostname, username }: ConfigFilter, matches: Match[]): boolean {
  // TODO: Maybe make this properly work... Match is an annoying thing to fully implement...
  for (const { type, negated, value } of matches) {
    const checker = MATCH_KEYWORDS[type][1];
    if (checker) {
      if (checker() === negated) return false;
      continue;
    }
    switch (type) {
      case 'host':
      case 'originalhost':
        if ((hostname.toLowerCase() === value!.toLowerCase()) === negated) return false;
        break;
      case 'localuser':
        if ((os.userInfo().username.toLowerCase() === value!.toLowerCase()) === negated) return false;
        break;
      case 'user':
        if ((!!username && username.toLowerCase() === value!.toLowerCase()) === negated) return false;
        break;
    }
  }
  return true;
}

function mergeConfigs(calculated: CalculatedConfig, second: HostConfig | MatchConfig): CalculatedConfig {
  return {
    ...second,
    ...calculated,
    identityFiles: [...calculated.identityFiles, ...second.identityFiles],
    matched: [...calculated.matched, second],
  };
}

export interface ConfigFilter {
  hostname: string;
  username?: string;
}
export async function getHostConfig(filter: ConfigFilter, global: GlobalConfig): Promise<CalculatedConfig> {
  const { hostname, username } = filter;
  let result: CalculatedConfig = { ...global, matched: [] };
  const uInfo = os.userInfo();
  const hName = os.hostname();
  const tokens: { [token: string]: any } = {
    h: hostname,
    n: hostname,
    r: username,
    d: os.homedir(),
    u: uInfo.username,
    i: uInfo.uid,
    L: hName.replace(/\..*$/, ''),
    l: hName,
  };
  for (const config of global.configs) {
    if ('hosts' in config && fitsPatterns(applyTokens(hostname, tokens), config.hosts)) {
      result = mergeConfigs(result, config);
    } else if ('matches' in config && fitsMatches(filter, config.matches)) {
      result = mergeConfigs(result, config);
    }
  }
  // type KeysToDelete = Exclude<keyof GlobalConfig | keyof HostConfig | keyof MatchConfig, keyof CommonConfig>;
  delete (result as any).configs;
  delete (result as any).hosts;
  delete (result as any).matches;
  return result;
}

(global as any).TEST_OPENSSH_PARSING = async (configpath: string = 'C:\\Users\\schoo_000\\.ssh\\config') => {
  const gc = await parseConfigFile(configpath);
  console.log('GlobalConfig', gc);
  // Following is based on `Host systeembeheer`
  console.log('systeembeheer', await getHostConfig({ hostname: 'systeembeheer' }, gc));
  // Following are based on `Match host github.com user SchoofsKelvin`
  console.log('github.com', await getHostConfig({ hostname: 'github.com' }, gc)); // Shouldn't work
  console.log('github.com - SchoofsKelvin', await getHostConfig({ hostname: 'github.com', username: 'SchoofsKelvin' }, gc)); // Should work
  console.log('github.com - Unknown', await getHostConfig({ hostname: 'github.com', username: 'Unknown' }, gc)); // Shouldn't work
};
