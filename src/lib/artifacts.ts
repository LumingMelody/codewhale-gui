export interface WorkspaceFileInfo {
  rel: string;
  name: string;
  path: string;
  directory: string;
  size: number;
  modified_ms: number;
}

const DELIVERABLE_EXTENSIONS = new Set([
  'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'tsv',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'tiff',
  'zip', 'tar', 'gz', '7z', 'rar',
  'txt', 'md', 'html', 'htm', 'json', 'xml',
  'mp3', 'wav', 'm4a', 'mp4', 'mov', 'webm',
]);

function isDeliverable(file: WorkspaceFileInfo): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ext ? DELIVERABLE_EXTENSIONS.has(ext) : false;
}

export function diffWorkspaceFiles(
  before: WorkspaceFileInfo[],
  after: WorkspaceFileInfo[],
): WorkspaceFileInfo[] {
  const previous = new Map(before.map((file) => [file.rel, file]));
  return after
    .filter((file) => {
      if (!isDeliverable(file)) return false;
      const old = previous.get(file.rel);
      return !old || old.size !== file.size || old.modified_ms !== file.modified_ms;
    })
    .sort((a, b) => b.modified_ms - a.modified_ms || a.rel.localeCompare(b.rel));
}

