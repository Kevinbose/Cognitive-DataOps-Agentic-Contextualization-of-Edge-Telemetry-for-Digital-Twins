/**
 * @file Asset ingestion form.
 *
 * Two-stage by design, mirroring the backend pipeline: the raw CAD file is
 * provenance, the `.glb` is what renders. Either can be supplied first.
 *
 * @module features/assets/pages/AssetUploadPage
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import Button from '../../../components/ui/Button.jsx';
import PageHeader from '../../../components/ui/PageHeader.jsx';
import Panel from '../../../components/ui/Panel.jsx';
import { ErrorState } from '../../../components/ui/Feedback.jsx';
import { FileField, SelectField, TextField } from '../../../components/ui/Field.jsx';
import { formatBytes } from '../../../lib/three-helpers.js';
import { usePageTitle } from '../../../lib/usePageTitle.js';
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
  usePageTitle('Ingest asset');
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
   * Warn before the tab is closed or reloaded while the form holds work.
   *
   * A chosen file cannot be restored by the browser, so losing the page to a
   * stray back-swipe costs the operator a re-pick of a multi-megabyte model.
   */
  const isDirty = Boolean(name || uploader || notes || cadFile || meshFile);
  useEffect(() => {
    if (!isDirty || isSubmitting) return undefined;
    /** @param {BeforeUnloadEvent} event */
    const warn = (event) => {
      event.preventDefault();
      // Legacy browsers require a return value to show the prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty, isSubmitting]);

  /**
   * After a failed validation, move focus to the first invalid control, so a
   * keyboard or screen-reader user lands on the problem instead of having to
   * hunt for it.
   */
  useEffect(() => {
    if (Object.keys(fieldErrors).length === 0) return;
    document.querySelector('form [aria-invalid="true"]')?.focus();
  }, [fieldErrors]);

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
      errors.meshFile =
        'Provide at least one file: a source CAD file, a converted mesh, or both.';
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
      <PageHeader title="Ingest asset">
        <p className="max-w-2xl text-[14px] text-ink-muted">
          Raw CAD is retained for provenance and is never rendered, because WebGL cannot draw
          parametric geometry. The converted <span translate="no">.glb</span> is what the twin
          viewer loads.
        </p>
      </PageHeader>

      {submitError ? (
        <ErrorState
          title="Ingestion failed"
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
                label="Asset name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                error={fieldErrors.name}
                placeholder="e.g. Tool and plant hire depot"
                autoComplete="off"
                name="assetName"
              />
              <TextField
                label="Uploader"
                required
                value={uploader}
                onChange={(event) => setUploader(event.target.value)}
                error={fieldErrors.uploader}
                placeholder="Full name"
                autoComplete="name"
                name="uploader"
              />
              <SelectField
                label="Source format"
                name="sourceType"
                autoComplete="off"
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

          <Panel title="File artefacts">
            <div className="space-y-5">
              <FileField
                label="Source CAD (provenance only)"
                accept=".stp,.step,.iges,.igs"
                name="originalFile"
                file={cadFile}
                onFileChange={setCadFile}
                error={fieldErrors.cadFile}
                hint="STEP or IGES, up to 25 MB. Stored for audit; never parsed or rendered."
              />

              <FileField
                label="Converted mesh (rendered in the viewer)"
                accept=".glb"
                name="convertedFile"
                file={meshFile}
                onFileChange={setMeshFile}
                error={fieldErrors.meshFile}
                hint="Binary glTF (.glb) only, up to 50 MB. Verified by magic bytes on upload."
              />

              {meshFile ? (
                <dl className="flex gap-8 border border-line bg-raised px-4 py-3">
                  <div>
                    <dt className="label-text">Mesh size</dt>
                    <dd className="data-readout mt-1 text-ink">{formatBytes(meshFile.size)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="label-text">Filename</dt>
                    <dd className="data-readout mt-1 truncate text-ink">{meshFile.name}</dd>
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
                guidelines: a pre-emptively disabled submit hides why. */}
            <Button type="submit" variant="primary" loading={isSubmitting} disabled={isSubmitting}>
              Ingest asset
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

export default AssetUploadPage;
