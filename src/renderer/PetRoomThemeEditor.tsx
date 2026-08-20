import { useEffect, useRef, useState } from "react";
import {
  type InstalledPetRoomThemePack,
  type PetRoomThemeColors,
  PET_ROOM_THEME_BACKGROUND_MAX_BYTES,
  parsePetRoomThemePackJson,
  serializePetRoomThemePack,
  validatePetRoomThemePack,
} from "./pet-room-theme-packs";

export interface PetRoomThemeEditorProps {
  activePack?: InstalledPetRoomThemePack;
  disabled?: boolean;
  onInstall: (pack: InstalledPetRoomThemePack) => void;
}

const defaultColors: PetRoomThemeColors = {
  top: "#e9e7ff",
  ground: "#d8d2f0",
  window: "#c8ddff",
  accent: "#746ee2",
};

export function PetRoomThemeEditor({
  activePack,
  disabled = false,
  onInstall,
}: PetRoomThemeEditorProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [colors, setColors] = useState<PetRoomThemeColors>(defaultColors);
  const [backgroundDataUrl, setBackgroundDataUrl] = useState<string>();
  const [error, setError] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);
  const backgroundInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setId("");
    setName("");
    setDescription("");
    setColors(defaultColors);
    setBackgroundDataUrl(undefined);
    setError("");
  };

  const loadActive = () => {
    if (!activePack) return;
    setId(activePack.id);
    setName(activePack.name);
    setDescription(activePack.description);
    setColors({ ...activePack.colors });
    setBackgroundDataUrl(activePack.backgroundDataUrl);
    setError("");
  };

  useEffect(() => {
    if (activePack && !id && !name) loadActive();
    // The active identity is the only external value that should hydrate the
    // local form; typing in the editor must not be overwritten on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePack?.id]);

  const submit = () => {
    const result = validatePetRoomThemePack({ id, name, description, colors, backgroundDataUrl });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onInstall(result.pack);
    setError("");
  };

  const exportActive = () => {
    if (!activePack || typeof document === "undefined") return;
    try {
      const blob = new Blob([serializePetRoomThemePack(activePack)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `todo-pet-theme-${activePack.id}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "主题包导出失败。");
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const result = parsePetRoomThemePackJson(await file.text());
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setId(result.pack.id);
      setName(result.pack.name);
      setDescription(result.pack.description);
      setColors({ ...result.pack.colors });
      setBackgroundDataUrl(result.pack.backgroundDataUrl);
      setError("");
    } catch {
      setError("主题包不是有效的 JSON。");
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const importBackground = async (file: File | undefined) => {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("背景只支持 PNG、JPEG 或 WebP 图片。");
      return;
    }
    if (file.size > PET_ROOM_THEME_BACKGROUND_MAX_BYTES) {
      setError("背景图片不能超过 512 KB。");
      return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败。"));
        reader.onerror = () => reject(new Error("图片读取失败。"));
        reader.readAsDataURL(file);
      });
      const result = validatePetRoomThemePack({
        id: id.trim() || "draft-theme",
        name: name.trim() || "草稿主题",
        description,
        colors,
        backgroundDataUrl: dataUrl,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setBackgroundDataUrl(result.pack.backgroundDataUrl);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "图片读取失败。");
    } finally {
      if (backgroundInputRef.current) backgroundInputRef.current.value = "";
    }
  };

  const updateColor = (key: keyof PetRoomThemeColors, value: string) => {
    setColors((current) => ({ ...current, [key]: value }));
    setError("");
  };

  return (
    <div className="pet-room-theme-editor" aria-label="小窝主题包编辑器">
      <div className="pet-room-theme-editor-heading">
        <div>
          <strong>小窝主题包</strong>
          <p>组合四种颜色，可选一张本地小图；只接受受限图片数据，不接受脚本、路径或网络地址。</p>
        </div>
        <span className="pet-room-theme-swatch" style={{ background: `linear-gradient(160deg, ${colors.top} 0 62%, ${colors.ground} 62%)` }} aria-hidden="true" />
      </div>
      <div className="pet-room-theme-editor-fields">
        <label>
          <span>包 ID</span>
          <input className="settings-input" value={id} disabled={disabled} onChange={(event) => { setId(event.target.value); setError(""); }} placeholder="misty-morning" maxLength={40} />
        </label>
        <label>
          <span>名称</span>
          <input className="settings-input" value={name} disabled={disabled} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder="晨雾" maxLength={40} />
        </label>
      </div>
      <label className="pet-room-theme-editor-description">
        <span>说明</span>
        <input className="settings-input" value={description} disabled={disabled} onChange={(event) => { setDescription(event.target.value); setError(""); }} placeholder="给小窝换一层轻雾色" maxLength={160} />
      </label>
      <div className="pet-room-theme-color-grid" role="group" aria-label="主题颜色">
        {([
          ["top", "顶部"],
          ["ground", "地面"],
          ["window", "窗户"],
          ["accent", "强调"],
        ] as const).map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <input type="color" value={colors[key]} disabled={disabled} aria-label={`${label}颜色`} onChange={(event) => updateColor(key, event.target.value)} />
            <code>{colors[key]}</code>
          </label>
        ))}
      </div>
      <div className="pet-room-theme-asset">
        <div>
          <strong>小窝背景图（可选）</strong>
          <p>仅支持 512 KB 以内的 PNG、JPEG 或 WebP；图片会随主题包一起保存在本机。</p>
        </div>
        {backgroundDataUrl ? (
          <div className="pet-room-theme-asset-preview">
            <img src={backgroundDataUrl} alt="" />
            <button type="button" className="ghost-button" disabled={disabled} onClick={() => setBackgroundDataUrl(undefined)}>移除图片</button>
          </div>
        ) : (
          <button type="button" className="ghost-button" disabled={disabled} onClick={() => backgroundInputRef.current?.click()}>选择本地图片</button>
        )}
        <input
          ref={backgroundInputRef}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="导入小窝背景图片"
          disabled={disabled}
          onChange={(event) => void importBackground(event.target.files?.[0])}
        />
      </div>
      <div className="settings-actions pet-room-theme-editor-actions">
        <button type="button" className="soft-button" disabled={disabled || !activePack} onClick={loadActive}>载入当前包</button>
        <button type="button" className="ghost-button" disabled={disabled} onClick={reset}>清空重来</button>
        <button type="button" className="ghost-button" disabled={disabled || !activePack} onClick={exportActive}>导出 JSON</button>
        <button type="button" className="ghost-button" disabled={disabled} onClick={() => importInputRef.current?.click()}>导入 JSON</button>
        <input
          ref={importInputRef}
          className="sr-only"
          type="file"
          accept="application/json,.json"
          aria-label="导入主题 JSON 文件"
          disabled={disabled}
          onChange={(event) => void importFile(event.target.files?.[0])}
        />
        <span className="action-spacer" />
        <button type="button" className="primary-button" disabled={disabled || !id.trim() || !name.trim()} onClick={submit}>安装并应用</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
