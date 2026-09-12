/**
 * @file Asset detail — metadata, artefacts, and the entry point to the twin.
 *
 * @module features/assets/pages/AssetDetailPage
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import Button from '../../../components/ui/Button.jsx';
import Panel from '../../../components/ui/Panel.jsx';
import StatusPill from '../../../components/ui/StatusPill.jsx';
import { ErrorState, LoadingState } from '../../../components/ui/Feedback.jsx';
import { FileField } from '../../../components/ui/Field.jsx';
import { formatBytes } from '../../../lib/three-helpers.js';
import { getErrorMessage } from '../../../services/apiSlice.js';
import {
  useDeleteAssetMutation,
  useGetAssetByIdQuery,
  useUploadConvertedFileMutation,
} from '../assetsApiSlice.js';

/**
 * One row in a definition list.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {import('react').ReactNode} props.children
 * @param {boolean} [props.mono]
 * @returns {import('react').JSX.Element}
 */
function DetailRow({ label, children, mono = false }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="label-micro sm:w-44 sm:shrink-0">{label}</dt>
      <dd className={`min-w-0 break-words text-[13px] text-ink ${mono ? 'data-readout' : 'font-sans'}`}>
        {children}
      </dd>
    </div>
  );
}

/**
 * @returns {import('react').JSX.Element}
 */
export function AssetDetailPage() {
  const { assetId } = useParams();
  const navigate = useNavigate();

  const { data: asset, isLoading, isError, error, refetch } = useGetAssetByIdQuery(assetId);
  const [uploadConverted, uploadState] = useUploadConvertedFileMutation();
  const [deleteAsset, deleteState] = useDeleteAssetMutation();

  const [meshFile, setMeshFile] = useState(null);
  const [uploadError, setUploadError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (isLoading) return <LoadingState label="Loading Asset…" />;

  if (isError) {
    return (
      <ErrorState
        title="Asset Unavailable"
        message={getErrorMessage(error)}
        action={
          <Button size="sm" onClick={refetch}>
            Retry Request
          </Button>
        }
      />
    );
  }

  async function handleMeshUpload() {
    setUploadError('');
    if (!meshFile) return;
    try {
      await uploadConverted({ assetId, file: meshFile }).unwrap();
      setMeshFile(null);
    } catch (caught) {
      setUploadError(getErrorMessage(caught));
    }
  }

  async function handleDelete() {
    try {
      await deleteAsset(assetId).unwrap();
      navigate('/assets');
    } catch (caught) {
      setUploadError(getErrorMessage(caught));
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Title block ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="label-micro mb-2">Asset Record</p>
          <h2 className="display-page break-words text-ink">{asset.name}</h2>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <StatusPill status={asset.status} />
            <span className="data-readout text-[11px] text-ink-subtle">{asset._id}</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <Button to="/assets">Back to Registry</Button>
          {asset.isRenderable ? (
            <>
              <Button to={`/assets/${assetId}/mapping`}>Mapping Table</Button>
              <Button to={`/assets/${assetId}/twin`} variant="primary">
                Open Digital Twin
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {uploadError ? (
        <ErrorState
          title="Operation Failed"
          message={uploadError}
          action={
            <Button size="sm" onClick={() => setUploadError('')}>
              Dismiss
            </Button>
          }
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Metadata ──────────────────────────────────────────────────────── */}
        <Panel title="Record Metadata">
          <dl>
            <DetailRow label="Uploader">{asset.uploader}</DetailRow>
            <DetailRow label="Source Format" mono>
              {asset.sourceType.toUpperCase()}
            </DetailRow>
            <DetailRow label="Mesh Version" mono>
              v{asset.version}
            </DetailRow>
            <DetailRow label="Created" mono>
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(asset.createdAt))}
            </DetailRow>
            <DetailRow label="Renderable" mono>
              {asset.isRenderable ? 'Yes' : 'No — awaiting converted mesh'}
            </DetailRow>
            {asset.metadata?.notes ? (
              <DetailRow label="Notes">{asset.metadata.notes}</DetailRow>
            ) : null}
          </dl>
        </Panel>

        {/* ── Artefacts ─────────────────────────────────────────────────────── */}
        <Panel title="File Artefacts">
          <div className="space-y-5">
            <div className="border border-line bg-sunken p-4">
              <p className="label-micro mb-2">Source CAD — Provenance</p>
              {asset.originalFile ? (
                <dl className="space-y-1.5">
                  <div className="flex justify-between gap-4">
                    <dt className="font-sans text-[12px] text-ink-muted">Filename</dt>
                    <dd className="data-readout min-w-0 truncate text-[12px] text-ink">
                      {asset.originalFile.originalName}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="font-sans text-[12px] text-ink-muted">Size</dt>
                    <dd className="data-readout text-[12px] text-ink">
                      {formatBytes(asset.originalFile.sizeBytes)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="font-sans text-[12px] text-ink-muted">SHA-256</dt>
                    <dd className="data-readout min-w-0 truncate text-[11px] text-ink-subtle">
                      {asset.originalFile.checksum.slice(0, 24)}…
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="font-sans text-[12px] text-ink-muted">No source CAD file on record.</p>
              )}
            </div>

            <div className="border border-line bg-sunken p-4">
              <p className="label-micro mb-2">Converted Mesh — Rendered</p>
              {asset.convertedFile ? (
                <dl className="space-y-1.5">
                  <div className="flex justify-between gap-4">
                    <dt className="font-sans text-[12px] text-ink-muted">Filename</dt>
                    <dd className="data-readout min-w-0 truncate text-[12px] text-ink">
                      {asset.convertedFile.originalName}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="font-sans text-[12px] text-ink-muted">Size</dt>
                    <dd className="data-readout text-[12px] text-ink">
                      {formatBytes(asset.convertedFile.sizeBytes)}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="font-sans text-[12px] text-ink-muted">
                  No mesh yet. Upload a <span translate="no">.glb</span> to enable the twin viewer.
                </p>
              )}
            </div>

            <div className="space-y-3 border-t border-line pt-4">
              <FileField
                label={asset.convertedFile ? 'Replace Converted Mesh' : 'Upload Converted Mesh'}
                accept=".glb"
                file={meshFile}
                onFileChange={setMeshFile}
                hint={
                  asset.convertedFile
                    ? 'Replacing bumps the version and busts the viewer cache. Existing sensor mappings are preserved.'
                    : 'Binary glTF (.glb) only, up to 50 MB.'
                }
              />
              <Button
                variant="primary"
                onClick={handleMeshUpload}
                disabled={!meshFile || uploadState.isLoading}
                loading={uploadState.isLoading}
              >
                Upload Mesh
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      {/* ── Danger zone ─────────────────────────────────────────────────────
          Destructive action behind an explicit confirmation step, never a
          single immediate click. */}
      <Panel title="Danger Zone">
        {confirmingDelete ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-sans text-[13px] text-ink">
              Soft-delete <strong>{asset.name}</strong>? Its mesh nodes and active sensor bindings
              will be retired. Stored files are kept for audit.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={handleDelete}
                loading={deleteState.isLoading}
              >
                Confirm Delete
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-sans text-[13px] text-ink-muted">
              Removes this asset from the registry. Reversible at the database level.
            </p>
            <Button size="sm" variant="danger" onClick={() => setConfirmingDelete(true)}>
              Delete Asset
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}

export default AssetDetailPage;
