import { Button } from '@affine/component';
import { useAsyncCallback } from '@affine/core/components/hooks/affine-async-hooks';
import { appIconMap } from '@affine/core/utils';
import { apis, events, sharedStorage } from '@affine/electron-api';
import { useI18n } from '@affine/i18n';
import track from '@affine/track';
import { useEffect, useMemo, useRef, useState } from 'react';

import * as styles from './styles.css';

type Status = {
  id: number;
  status:
    | 'new'
    | 'starting'
    | 'start_failed'
    | 'recording'
    | 'finalizing'
    | 'pending_import'
    | 'importing'
    | 'imported'
    | 'import_failed'
    | 'finalize_failed';
  appName?: string;
  appGroupId?: number;
  icon?: Buffer;
  filepath?: string;
  sampleRate?: number;
  numberOfChannels?: number;
};

export const useRecordingStatus = () => {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    // Get initial status
    apis?.recording
      .getCurrentRecording()
      .then(status => setStatus(status satisfies Status | null))
      .catch(console.error);

    // Subscribe to status changes
    const unsubscribe = events?.recording.onRecordingStatusChanged(status =>
      setStatus(status satisfies Status | null)
    );

    return () => {
      unsubscribe?.();
    };
  }, []);

  return status;
};

const appIcon = appIconMap[BUILD_CONFIG.appBuildType];

type TranscriptionModelTarget = { profileId: string; modelId: string };
type MeetingSettings = {
  transcriptionModels?: TranscriptionModelTarget[];
  transcriptionTarget?: TranscriptionModelTarget | null;
};
const MEETING_SETTINGS_KEY = 'meetingSettings';

const useMeetingSettings = () => {
  const [settings, setSettings] = useState<MeetingSettings>({});

  useEffect(() => {
    const storage = sharedStorage?.globalState;
    if (!storage) {
      return;
    }
    setSettings(storage.get<MeetingSettings>(MEETING_SETTINGS_KEY) ?? {});
    const unsubscribe = storage.watch<MeetingSettings>(
      MEETING_SETTINGS_KEY,
      value => setSettings(value ?? {})
    );
    return () => unsubscribe?.();
  }, []);

  return settings;
};

const setTranscriptionTarget = (target: TranscriptionModelTarget | null) => {
  const storage = sharedStorage?.globalState;
  if (!storage) {
    return;
  }
  storage.set(MEETING_SETTINGS_KEY, {
    ...(storage.get<MeetingSettings>(MEETING_SETTINGS_KEY) ?? {}),
    transcriptionTarget: target,
  });
};

export function Recording() {
  const status = useRecordingStatus();
  const meetingSettings = useMeetingSettings();
  const transcriptionModels = meetingSettings.transcriptionModels ?? [];
  const transcriptionTarget = meetingSettings.transcriptionTarget ?? null;
  const trackedNewRecordingIdsRef = useRef<Set<number>>(new Set());

  const t = useI18n();
  const textElement = useMemo(() => {
    if (!status) {
      return null;
    }
    if (status.status === 'new') {
      return t['com.affine.recording.new']();
    } else if (status.status === 'imported') {
      return t['com.affine.recording.success.prompt']();
    } else if (
      status.status === 'import_failed' ||
      status.status === 'start_failed' ||
      status.status === 'finalize_failed'
    ) {
      return t['com.affine.recording.failed.prompt']();
    } else if (
      status.status === 'starting' ||
      status.status === 'recording' ||
      status.status === 'finalizing'
    ) {
      if (status.appName) {
        return t['com.affine.recording.recording']({
          appName: status.appName,
        });
      } else {
        return t['com.affine.recording.recording.unnamed']();
      }
    } else if (
      status.status === 'pending_import' ||
      status.status === 'importing'
    ) {
      return t['com.affine.recording.importing.prompt']();
    }
    return null;
  }, [status, t]);

  const handleDismiss = useAsyncCallback(async () => {
    if (status) {
      await apis?.recording?.dismissRecordingStatus(status.id);
    }
    await apis?.popup?.dismissCurrentRecording();
    track.popup.$.recordingBar.dismissRecording({
      type: 'Meeting record',
      appName: status?.appName || 'System Audio',
    });
  }, [status]);

  const handleStopRecording = useAsyncCallback(async () => {
    if (!status) {
      return;
    }
    track.popup.$.recordingBar.finishRecording({
      type: 'Meeting record',
      appName: status.appName || 'System Audio',
    });
    await apis?.recording?.stopRecording(status.id);
  }, [status]);

  useEffect(() => {
    if (!status || status.status !== 'new') return;
    if (trackedNewRecordingIdsRef.current.has(status.id)) return;

    trackedNewRecordingIdsRef.current.add(status.id);
    track.popup.$.recordingBar.toggleRecordingBar({
      type: 'Meeting record',
      appName: status.appName || 'System Audio',
    });
  }, [status]);

  const handleStartRecording = useAsyncCallback(async () => {
    if (!status) {
      return;
    }
    track.popup.$.recordingBar.startRecording({
      type: 'Meeting record',
      appName: status.appName || 'System Audio',
    });
    await apis?.recording?.startRecording(status.appGroupId);
  }, [status]);

  const handleOpenFile = useAsyncCallback(async () => {
    if (!status) {
      return;
    }
    await apis?.recording?.showSavedRecordings(status.filepath);
  }, [status]);

  const controlsElement = useMemo(() => {
    if (!status) {
      return null;
    }
    if (status.status === 'new') {
      return (
        <>
          <Button variant="plain" onClick={handleDismiss}>
            {t['com.affine.recording.dismiss']()}
          </Button>
          <Button
            onClick={handleStartRecording}
            variant="primary"
            prefix={<div className={styles.recordingIcon} />}
          >
            {t['com.affine.recording.start']()}
          </Button>
        </>
      );
    } else if (status.status === 'recording') {
      return (
        <Button variant="error" onClick={handleStopRecording}>
          {t['com.affine.recording.stop']()}
        </Button>
      );
    } else if (
      status.status === 'starting' ||
      status.status === 'finalizing' ||
      status.status === 'pending_import' ||
      status.status === 'importing'
    ) {
      return (
        <Button
          variant="error"
          onClick={handleDismiss}
          loading={true}
          disabled
        />
      );
    } else if (status.status === 'imported') {
      return (
        <Button variant="primary" onClick={handleDismiss}>
          {t['com.affine.recording.success.button']()}
        </Button>
      );
    } else if (status.status === 'start_failed') {
      return (
        <Button variant="plain" onClick={handleDismiss}>
          {t['com.affine.recording.dismiss']()}
        </Button>
      );
    } else if (
      status.status === 'import_failed' ||
      status.status === 'finalize_failed'
    ) {
      return (
        <>
          <Button variant="plain" onClick={handleDismiss}>
            {t['com.affine.recording.dismiss']()}
          </Button>
          <Button variant="error" onClick={handleOpenFile}>
            {t['com.affine.recording.failed.button']()}
          </Button>
        </>
      );
    }
    return null;
  }, [
    handleDismiss,
    handleOpenFile,
    handleStartRecording,
    handleStopRecording,
    status,
    t,
  ]);

  if (!status) {
    return null;
  }

  return (
    <div className={styles.root}>
      <img className={styles.affineIcon} src={appIcon} alt="AFFiNE" />
      <div className={styles.text}>{textElement}</div>
      {transcriptionModels.length > 0 ? (
        <select
          className={styles.modelSelect}
          aria-label={t['com.affine.recording.transcription-model']()}
          title={t['com.affine.recording.transcription-model']()}
          value={
            transcriptionTarget
              ? `${transcriptionTarget.profileId}:${transcriptionTarget.modelId}`
              : ''
          }
          onChange={event => {
            const value = event.target.value;
            const model =
              transcriptionModels.find(
                model => `${model.profileId}:${model.modelId}` === value
              ) ?? null;
            setTranscriptionTarget(model);
          }}
        >
          <option value="">
            {t['com.affine.audio.transcribe.model.default']()}
          </option>
          {transcriptionModels.map(model => (
            <option
              key={`${model.profileId}:${model.modelId}`}
              value={`${model.profileId}:${model.modelId}`}
            >
              {model.modelId}
            </option>
          ))}
        </select>
      ) : null}
      <div className={styles.controls}>{controlsElement}</div>
    </div>
  );
}
