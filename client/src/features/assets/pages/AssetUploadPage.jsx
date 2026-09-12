/**
 * @file Asset ingestion form.
 *
 * Two-stage by design, mirroring the backend pipeline: the raw CAD file is
 * provenance, the `.glb` is what renders. Either can be supplied first.
 *
 * @module features/assets/pages/AssetUploadPage
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import Button from '../../../components/ui/Button.jsx';
import Panel from '../../../components/ui/Panel.jsx';
import { ErrorState } from '../../../components/ui/Feedback.jsx';
import { FileField, SelectField, TextField } from '../../../components/ui/Field.jsx';
import { formatBytes } from '../../../lib/three-helpers.js';
import { getErrorMessage } from '../../../services/apiSlice.js';
import { useCreateAssetMutation, useUploadConvertedFileMutation } from '../assetsApiSlice.js';

/** Mirrors the backend's `sourceType` enum. */
const SOURCE_TYPES = [
  { value: 'stp', label: 'STEP (.stp)' },
  { value: 'step', label: 'STEP (.step)' },
  { value: 'iges', label: 'IGES (.iges / .igs)' },
  { value: 'other', label: 'Other' },
];

/**
 * @returns {import('react').JSX.Element}
 */
export function AssetUploadPage() {
  const navigate = useNavigate();

  const [createAsset, createState] = useCreateAssetMutation();
  const [uploadConverted, uploadState] = useUploadConvertedFileMutation();

  const [name, setName] = useState('');
  const [uploader, setUploader] = useState('');
  const [sourceType, setSourceType] = useState('stp');
  const [notes, setNotes] = useState('');
  const [cadFile, setCadFile] = useState(null);
  const [meshFile, setMeshFile] = useState(null);

  /** @type {[Record<string, string>, Function]} */
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState('');

  const isSubmitting = createState.isLoading || uploadState.isLoading;

  /**
   * Validate before hitting the network, so obvious mistakes surface instantly
   * and every problem is reported at once rather than one per round trip.
   * @returns {boolean} Whether the form is valid.
   */
  function validate() {
    /** @type {Record<string, string>} */
    const errors = {};

    if (!name.trim()) errors.name = 'Asset name is required.';
    if (!uploader.trim()) errors.uploader = 'Uploader name is required.';
    if (!cadFile && !meshFile) {
      errors.meshFile = 'Provide at least one file — a source CAD file, a converted mesh, or both.';
    }
    if (meshFile && !meshFile.name.toLowerCase().endsWith('.glb')) {
      errors.meshFile = 'The converted mesh must be a .glb file. Pack a .gltf + .bin pair first.';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  /** @param {import('react').FormEvent} event */
  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitError('');
    if (!validate()) return;

    try {
      const formData = new FormData();
      formData.append('name', name.trim());
      formData.append('uploader', uploader.trim());
      formData.append('sourceType', sourceType);
      if (notes.trim()) formData.append('notes', notes.trim());
      if (cadFile) formData.append('originalFile', cadFile);

      const asset = await createAsset(formData).unwrap();

      // Two calls, because the endpoints are separate: create-with-CAD, then
      // attach the mesh. `.unwrap()` makes a failure throw so this stops here
      // rather than navigating to a half-built asset.
      if (meshFile) {
        await uploadConverted({ assetId: asset._id, file: meshFile }).unwrap();
      }

      navigate(`/assets/${asset._id}`);
    } catch (error) {
      setSubmitError(getErrorMessage(error));
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h2 className="display-page text-ink">Ingest Asset</h2>
        <p className="mt-2 max-w-2xl font-sans text-[13px] leading-relaxed text-ink-muted">
          Raw CAD is retained for provenance and is never rendered — WebGL cannot draw parametric
          geometry. The converted <span translate="no">.glb</span> is what the twin viewer loads.
        </p>
      </div>

      {submitError ? (
        <ErrorState
          title="Ingestion Failed"
          message={submitError}
          action={
            <Button size="sm" onClick={() => setSubmitError('')}>
              Dismiss
            </Button>
          }
        />
      ) : null}

      <form onSubmit={handleSubmit} noValidate>
        <div className="space-y-6">
          <Panel title="Identification">
            <div className="grid gap-5 md:grid-cols-2">
              <TextField
                label="Asset Name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                error={fieldErrors.name}
                placeholder="e.g. Tool & Plant Hire Depot"
                autoComplete="off"
                name="assetName"
              />
              <TextField
                label="Uploader"
                required
                value={uploader}
                onChange={(event) => setUploader(event.target.value)}
                error={fieldErrors.uploader}
                placeholder="e.g. Kevin Bose J"
                autoComplete="name"
                name="uploader"
              />
              <SelectField
                label="Source Format"
                options={SOURCE_TYPES}
                value={sourceType}
                onChange={(event) => setSourceType(event.target.value)}
                hint="Recorded as metadata; it does not affect processing."
              />
              <TextField
                label="Notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Optional commissioning notes…"
                autoComplete="off"
                name="notes"
              />
            </div>
          </Panel>

          <Panel title="File Artefacts">
            <div className="space-y-5">
              <FileField
                label="Source CAD — Provenance Only"
                accept=".stp,.step,.iges,.igs"
                file={cadFile}
                onFileChange={setCadFile}
                error={fieldErrors.cadFile}
                hint="STEP or IGES, up to 25 MB. Stored for audit; never parsed or rendered."
              />

              <FileField
                label="Converted Mesh — Rendered in the Viewer"
                accept=".glb"
                file={meshFile}
                onFileChange={setMeshFile}
                error={fieldErrors.meshFile}
                hint="Binary glTF (.glb) only, up to 50 MB. Verified by magic bytes on upload."
              />

              {meshFile ? (
                <dl className="flex gap-6 border border-line bg-sunken px-4 py-3">
                  <div>
                    <dt className="label-micro">Mesh Size</dt>
                    <dd className="data-readout mt-1 text-[13px] text-ink">
                      {formatBytes(meshFile.size)}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="label-micro">Filename</dt>
                    <dd className="data-readout mt-1 truncate text-[13px] text-ink">
                      {meshFile.name}
                    </dd>
                  </div>
                </dl>
              ) : null}
            </div>
          </Panel>

          <div className="flex items-center justify-end gap-3">
            <Button to="/assets" size="md">
              Cancel
            </Button>
            {/* Stays enabled until the request actually starts, per the
                guidelines — a pre-emptively disabled submit hides why. */}
            <Button type="submit" variant="primary" loading={isSubmitting} disabled={isSubmitting}>
              Ingest Asset
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default AssetUploadPage;
