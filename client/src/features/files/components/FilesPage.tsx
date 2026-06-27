import { formatBytes } from "../../../lib/api";
import { Container, Card, Eyebrow, Field, Input, Select, ProgressBar } from "../../../components/ui/primitives";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import { UploadCard } from "./UploadCard";
import { FilesList } from "./FilesList";
import { ApiKeysSection } from "./ApiKeysSection";
import { ShareModal } from "./ShareModal";
import { useFiles } from "../hooks/useFiles";

export function FilesPage() {
  const {
    usage, perms, mode, queue, options, setOptions,
    dirs, files, listLoading, uploading, progress,
    remote, setRemote, receive, setReceive,
    shareSpec, setShareSpec,
    mintFileId, setMintFileId, mintFields, setMintFields,
    dirModalOpen, setDirModalOpen, dirFields, setDirFields,
    changeMode, addFiles, removeItem, clearQueue,
    startUpload, startRemote, startReceive,
    actions, confirmMint, confirmNewFolder,
    loadFiles,
  } = useFiles();

  const pct = usage && usage.quota > 0 ? Math.min(100, (usage.used / usage.quota) * 100) : 0;
  const quotaTone = pct >= 90 ? "bad" : pct >= 70 ? "warn" : "accent";

  return (
    <Container>
      {usage && (
        <Card className="reveal mb-5">
          <div className="mb-2 flex items-center justify-between text-sm">
            <Eyebrow>Storage</Eyebrow>
            <span className="font-[var(--font-mono)] text-[var(--color-ink-dim)]">
              {formatBytes(usage.used)} used of {formatBytes(usage.quota)}
            </span>
          </div>
          <ProgressBar percent={pct} tone={quotaTone} />
        </Card>
      )}

      <UploadCard
        perms={perms}
        mode={mode}
        setMode={changeMode}
        queue={queue}
        addFiles={addFiles}
        removeItem={removeItem}
        clearQueue={clearQueue}
        startUpload={startUpload}
        uploading={uploading}
        progress={progress}
        options={options}
        setOptions={setOptions}
        remote={remote}
        setRemote={setRemote}
        startRemote={startRemote}
        receive={receive}
        setReceive={setReceive}
        startReceive={startReceive}
      />

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <Eyebrow>Your files &amp; folders</Eyebrow>
          <div className="flex gap-2">
            {perms.canCreateDirectories && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDirFields({ title: "", encMode: "none", expires: "" });
                  setDirModalOpen(true);
                }}
              >
                New folder
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={loadFiles}>
              Refresh
            </Button>
          </div>
        </div>
        <FilesList dirs={dirs} files={files} loading={listLoading} perms={perms} actions={actions} />
      </section>

      {perms.canUseApiKeys && <ApiKeysSection />}

      <ShareModal spec={shareSpec} onClose={() => setShareSpec(null)} />

      {/* Mint link modal */}
      <Modal
        open={mintFileId != null}
        onClose={() => setMintFileId(null)}
        title="Create a new link"
        footer={
          <>
            <Button variant="ghost" onClick={() => setMintFileId(null)}>
              Cancel
            </Button>
            <Button onClick={confirmMint}>Create link</Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Max downloads">
            <Input
              autoFocus
              placeholder="unlimited"
              value={mintFields.maxUses}
              onChange={(e) => setMintFields((f) => ({ ...f, maxUses: e.target.value }))}
            />
          </Field>
          <Field label="Expires in">
            <Input
              placeholder='e.g. "7d"'
              value={mintFields.expires}
              onChange={(e) => setMintFields((f) => ({ ...f, expires: e.target.value }))}
            />
          </Field>
        </div>
      </Modal>

      {/* New folder modal */}
      <Modal
        open={dirModalOpen}
        onClose={() => setDirModalOpen(false)}
        title="New shared folder"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDirModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmNewFolder}>Create folder</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Title">
            <Input
              autoFocus
              placeholder="Shared folder"
              value={dirFields.title}
              onChange={(e) => setDirFields((f) => ({ ...f, title: e.target.value }))}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Encryption">
              <Select
                value={dirFields.encMode}
                onChange={(e) => setDirFields((f) => ({ ...f, encMode: e.target.value }))}
              >
                <option value="none">None</option>
                <option value="server">Server-side (?ek=)</option>
                {perms.canUploadClientEncrypted && <option value="client">End-to-end (#ek=)</option>}
              </Select>
            </Field>
            <Field label="Expires in">
              <Input
                placeholder="optional"
                value={dirFields.expires}
                onChange={(e) => setDirFields((f) => ({ ...f, expires: e.target.value }))}
              />
            </Field>
          </div>
        </div>
      </Modal>
    </Container>
  );
}
