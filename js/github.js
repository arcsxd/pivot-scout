// Cliente mínimo da API REST do GitHub (Contents + Git Data).
const API = 'https://api.github.com';

export function bytesToB64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const utf8ToB64 = (str) => bytesToB64(new TextEncoder().encode(str));
export const b64ToUtf8 = (b64) => new TextDecoder().decode(b64ToBytes(b64));
export const blobToB64 = async (blob) => bytesToB64(new Uint8Array(await blob.arrayBuffer()));

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GitHub {
  constructor({ token, owner, repo }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }

  async req(method, path, { body, accept, raw } = {}) {
    const base = `${API}/repos/${this.owner}/${this.repo}`;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(path ? `${base}/${path}` : base, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).message || msg;
      } catch { /* sem corpo */ }
      throw new GitHubError(res.status, msg);
    }
    if (raw) return res;
    if (res.status === 204) return null;
    return res.json();
  }

  contentsPath(p) {
    return 'contents/' + p.split('/').map(encodeURIComponent).join('/');
  }

  repoInfo() {
    return this.req('GET', '');
  }

  /** Lê um arquivo de texto. Retorna {sha, text} ou null se não existir. */
  async getFile(path) {
    try {
      const j = await this.req('GET', this.contentsPath(path));
      return { sha: j.sha, text: b64ToUtf8(j.content || '') };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async getJSON(path) {
    const f = await this.getFile(path);
    return f ? { sha: f.sha, data: JSON.parse(f.text) } : null;
  }

  /** Lista uma pasta. Pasta inexistente vira lista vazia. */
  async listDir(path) {
    try {
      const j = await this.req('GET', this.contentsPath(path));
      return Array.isArray(j) ? j : [];
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  async getRawBlob(path) {
    const res = await this.req('GET', this.contentsPath(path), {
      accept: 'application/vnd.github.raw',
      raw: true,
    });
    return res.blob();
  }

  /** Cria ou atualiza um arquivo (conteúdo em base64). Retorna o novo sha. */
  async putFile(path, b64, message, sha) {
    const body = { message, content: b64 };
    if (sha) body.sha = sha;
    const j = await this.req('PUT', this.contentsPath(path), { body });
    return j.content.sha;
  }

  putJSON(path, obj, message, sha) {
    return this.putFile(path, utf8ToB64(JSON.stringify(obj, null, 2) + '\n'), message, sha);
  }

  /**
   * Grava um arquivo mesmo que ele já exista (busca o sha se precisar)
   * e tenta de novo em caso de conflito de commits simultâneos.
   */
  async upsert(path, b64, message) {
    let sha;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.putFile(path, b64, message, sha);
      } catch (e) {
        if (e.status === 422 || e.status === 409) {
          if (e.status === 422) {
            const cur = await this.getFile(path);
            sha = cur?.sha;
          }
          await sleep(600 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    throw new GitHubError(409, 'Conflito ao gravar ' + path);
  }

  async deleteFile(path, sha, message) {
    await this.req('DELETE', this.contentsPath(path), { body: { message, sha } });
  }

  /** Grava vários arquivos de texto num único commit (API Git Data). */
  async commitFiles(files, message) {
    const info = await this.repoInfo();
    const branch = info.default_branch;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = await this.req('GET', `git/ref/heads/${branch}`);
      const base = ref.object.sha;
      const commit = await this.req('GET', `git/commits/${base}`);
      const tree = await this.req('POST', 'git/trees', {
        body: {
          base_tree: commit.tree.sha,
          tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
        },
      });
      const c = await this.req('POST', 'git/commits', {
        body: { message, tree: tree.sha, parents: [base] },
      });
      try {
        await this.req('PATCH', `git/refs/heads/${branch}`, { body: { sha: c.sha } });
        return c.sha;
      } catch (e) {
        if (e.status !== 422) throw e;
        await sleep(800);
      }
    }
    throw new GitHubError(409, 'Não foi possível gravar: o repositório mudou durante a gravação.');
  }
}
