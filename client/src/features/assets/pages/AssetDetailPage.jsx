/**
 * @file Asset detail — metadata, artefacts, and the entry point to the twin.
 *
 * Laid out as a datasheet: a ruled definition list for the record, a two-row
 * table for its two file artefacts, and a danger section with a full alarm
 * border.
 *
 * @module features/assets/pages/AssetDetailPage
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import Button from '../../../components/ui/Button.jsx';
import PageHeader from '../../../components/ui/PageHeader.jsx';
import Panel from '../../../components/ui/Panel.jsx';
import StatusPill from '../../../components/ui/StatusPill.jsx';
import { ErrorState, LoadingState } from '../../../components/ui/Feedback.jsx';
import { FileField } from '../../../components/ui/Field.jsx';
import { ArrowLeft } from '../../../components/ui/icons.js';
import { formatBytes } from '../../../lib/three-helpers.js';
import { usePageTitle } from '../../../lib/usePageTitle.js';
import { getErrorMessage } from '../../../services/apiSlice.js';
import { useAssetRoom } from '../../telemetry/realtime/socketClient.js';
import {
  useDeleteAssetMutation,
  useGetAssetByIdQuery,
  useUploadConvertedFileMutation,
} from '../assetsApiSlice.js';

/**
 * One row of the datasheet: a fixed-width label column and the value.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {import('react').ReactNode} props.children
 * @param {boolean} [props.mono]
 * @returns {import('react').JSX.Element}
 */
function DetailRow({ label, children, mono = false }) {
  return (
    <div className="grid gap-1 border-b border-line py-3 last:border-b-0 sm:grid-cols-[160px_1fr] sm:gap-4">
      <dt className="label-text text-ink-secondary">{label}</dt>
      <dd className={`min-w-0 break-words text-[14px] text-ink ${mono ? 'data-readout' : ''}`}>
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

  usePageTitle(asset?.name ? `${asset.name}, asset record` : 'Asset record');
  // Binding a sensor in another tab promotes this asset's status; hear about it.
  useAssetRoom(assetId);

  if (isLoading) {
    return (
      <>
        <h1 className="sr-only">Asset record</h1>
        <LoadingState variant="page" label="Loading asset…" />
      </>
    );
  }

  if (isError) {
    return (
      <>
        <h1 className="sr-only">Asset record</h1>
        <ErrorState
          title="Asset unavailable"
          message={getErrorMessage(error)}
          action={
            <Button size="sm" onClick={refetch}>
              Retry request
            </Button>
          }
        />
      </>
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
      <PageHeader
        title={asset.name}
        actions={
          <>
            <Button to="/assets" icon={ArrowLeft}>
              Back to registry
            </Button>
            {asset.isRenderable ? (
              <>
                <Button to={`/assets/${assetId}/mapping`}>Mapping table</Button>
                <Button to={`/assets/${assetId}/twin`} variant="primary">
                  Open digital twin
                </Button>
              </>
            ) : null}
          </>
        }
      >
        <StatusPill status={asset.status} />
        <span className="data-readout text-xs text-ink-muted" translate="no">
          {asset._id}
        </span>
      </PageHeader>

      {uploadError ? (
        <ErrorState
          title="Operation failed"
          message={uploadError}
          action={
            <Button size="sm" onClick={() => setUploadError('')}>
              Dismiss
            </Button>
          }
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-12">
        {/* ── Metadata ──────────────────────────────────────────────────────── */}
        <Panel title="Record metadata" className="lg:col-span-7">
          <dl>
            <DetailRow label="Uploader">{asset.uploader}</DetailRow>
            <DetailRow label="Source format" mono>
              {asset.sourceType.toUpperCase()}
            </DetailRow>
            <DetailRow label="Mesh version" mono>
              v{asset.version}
            </DetailRow>
            <DetailRow label="Created" mono>
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(asset.createdAt))}
            </DetailRow>
            <DetailRow label="Renderable">
              {asset.isRenderable ? 'Yes' : 'No, awaiting a converted mesh'}
            </DetailRow>
            {asset.metadata?.notes ? (
              <DetailRow label="Notes">{asset.metadata.notes}</DetailRow>
            ) : null}
          </dl>
        </Panel>

        {/* ── Artefacts ─────────────────────────────────────────────────────── */}
        <Panel title="File artefacts" className="lg:col-span-5" flush>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="File artefacts, scrollable">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-sunken">
                  <th scope="col" className="px-5 py-2.5 text-xs font-semibold text-ink-secondary">
                    Artefact
                  </th>
                  <th scope="col" className="px-5 py-2.5 text-xs font-semibold text-ink-secondary">
                    File
                  </th>
                  <th
                    scope="col"
                    className="px-5 py-2.5 text-right text-xs font-semibold text-ink-secondary"
                  >
                    Size
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-line align-top">
                  <th scope="row" className="px-5 py-3 text-left text-[13px] font-medium text-ink">
                    Source CAD
                    <span className="block text-xs font-normal text-ink-muted">Provenance only</span>
                  </th>
                  <td className="data-readout max-w-[14rem] px-5 py-3 text-ink">
                    {asset.originalFile ? (
                      <>
                        <span className="block truncate">{asset.originalFile.originalName}</span>
                        <span className="block truncate text-xs text-ink-muted" translate="no">
                          SHA-256 {asset.originalFile.checksum.slice(0, 16)}…
                        </span>
                      </>
                    ) : (
                      <span className="font-sans text-[13px] text-ink-muted">None on record</span>
                    )}
                  </td>
                  <td className="data-readout px-5 py-3 text-right text-ink-secondary">
                    {asset.originalFile ? formatBytes(asset.originalFile.sizeBytes) : ''}
                  </td>
                </tr>
                <tr className="align-top">
                  <th scope="row" className="px-5 py-3 text-left text-[13px] font-medium text-ink">
                    Converted mesh
                    <span className="block text-xs font-normal text-ink-muted">Rendered</span>
                  </th>
                  <td className="data-readout max-w-[14rem] px-5 py-3 text-ink">
                    {asset.convertedFile ? (
                      <span className="block truncate">{asset.convertedFile.originalName}</span>
                    ) : (
                      <span className="font-sans text-[13px] text-ink-muted">
                        None yet. Upload a <span translate="no">.glb</span> to enable the viewer.
                      </span>
                    )}
                  </td>
                  <td className="data-readout px-5 py-3 text-right text-ink-secondary">
                    {asset.convertedFile ? formatBytes(asset.convertedFile.sizeBytes) : ''}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="space-y-3 border-t border-line p-5">
            <FileField
              label={asset.convertedFile ? 'Replace converted mesh' : 'Upload converted mesh'}
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
              Upload mesh
            </Button>
          </div>
        </Panel>
      </div>

      {/* ── Danger zone ─────────────────────────────────────────────────────
          Destructive action behind an explicit confirmation step, never a
          single immediate click. Full alarm border, no fill. */}
      <Panel title="Danger zone" tone="danger">
        {confirmingDelete ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[14px] text-ink">
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
                Confirm delete
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[14px] text-ink-muted">
              Removes this asset from the registry. Reversible at the database level.
            </p>
            <Button size="sm" variant="danger" onClick={() => setConfirmingDelete(true)}>
              Delete asset
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}

export default AssetDetailPage;
