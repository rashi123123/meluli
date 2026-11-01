import { useEffect, useState } from "react";
import { he } from "@shared/locale";

export interface MicrophoneDeviceOption {
  deviceId: string;
  label: string;
}

function buildFallbackLabel(index: number): string {
  return `${he.microphone} ${index + 1}`;
}

export function useMicrophoneDevices(selectedDeviceId?: string | null, refreshKey?: string | null) {
  const [devices, setDevices] = useState<MicrophoneDeviceOption[]>([]);
  const [defaultLabel, setDefaultLabel] = useState<string>(he.systemMicrophone);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    let cancelled = false;

    const updateDevices = async () => {
      try {
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) {
          return;
        }

        const audioInputs = allDevices.filter((device) => device.kind === "audioinput");
        const nextDefaultLabel =
          audioInputs.find((device) => device.deviceId === "default")?.label.trim().replace(/^Default\s*-\s*/i, "") || he.systemMicrophone;
        const nextDevices = audioInputs
          .filter((device) => device.deviceId !== "default" && device.deviceId !== "communications")
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label.trim() || buildFallbackLabel(index)
          }));

        setDefaultLabel(nextDefaultLabel);
        setDevices(nextDevices);
      } catch {
        if (cancelled) {
          return;
        }

        setDefaultLabel(he.systemMicrophone);
        setDevices([]);
      }
    };

    void updateDevices();

    const handleDeviceChange = () => {
      void updateDevices();
    };

    navigator.mediaDevices.addEventListener?.("devicechange", handleDeviceChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", handleDeviceChange);
    };
  }, [refreshKey]);

  const selectedLabel = selectedDeviceId
    ? devices.find((device) => device.deviceId === selectedDeviceId)?.label ?? he.microphoneUnavailable
    : defaultLabel;

  return {
    devices,
    defaultLabel,
    selectedLabel
  };
}
