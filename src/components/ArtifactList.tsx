import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import type { WorkspaceFileInfo } from '../lib/artifacts';
import { FileIcon } from './Icons';

export default function ArtifactList({
  files,
  onError,
}: {
  files: WorkspaceFileInfo[];
  onError: (message: string) => void;
}) {
  const open = async (path: string) => {
    try {
      await openPath(path);
    } catch (error) {
      onError(`打开文件失败: ${String(error)}`);
    }
  };

  const reveal = async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch (error) {
      onError(`定位文件失败: ${String(error)}`);
    }
  };

  return (
    <section className="artifact-panel" aria-label="本轮生成的文件">
      <div className="artifact-heading">
        <span>本轮生成 / 更新的文件</span>
        <span className="artifact-count">{files.length}</span>
      </div>
      {files.map((file) => (
        <div className="artifact-card" key={file.rel}>
          <span className="artifact-file-icon">
            <FileIcon size={18} />
          </span>
          <div className="artifact-copy">
            <strong title={file.path}>{file.name}</strong>
            <span title={file.directory}>所在目录：{file.directory}</span>
          </div>
          <div className="artifact-actions">
            <button type="button" onClick={() => void open(file.path)}>
              打开文件
            </button>
            <button type="button" onClick={() => void reveal(file.path)}>
              在目录中显示
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
