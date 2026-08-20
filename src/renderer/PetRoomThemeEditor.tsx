import { useEffect, useState } from "react";
import {
  type InstalledPetRoomThemePack,
  type PetRoomThemeColors,
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
  const [error, setError] = useState("");

  const reset = () => {
    setId("");
    setName("");
    setDescription("");
    setColors(defaultColors);
    setError("");
  };

  const loadActive = () => {
    if (!activePack) return;
    setId(activePack.id);
    setName(activePack.name);
    setDescription(activePack.description);
    setColors({ ...activePack.colors });
    setError("");
  };

  useEffect(() => {
    if (activePack && !id && !name) loadActive();
    // The active identity is the only external value that should hydrate the
    // local form; typing in the editor must not be overwritten on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePack?.id]);

  const submit = () => {
    const result = validatePetRoomThemePack({ id, name, description, colors });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onInstall(result.pack);
    setError("");
  };

  const updateColor = (key: keyof PetRoomThemeColors, value: string) => {
    setColors((current) => ({ ...current, [key]: value }));
    setError("");
  };

  return (
    <div className="pet-room-theme-editor" aria-label="小窝颜色主题编辑器">
      <div className="pet-room-theme-editor-heading">
        <div>
          <strong>颜色主题包</strong>
          <p>组合四种颜色，主题只在本机生效，不接受脚本、图片路径或网络地址。</p>
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
      <div className="settings-actions pet-room-theme-editor-actions">
        <button type="button" className="soft-button" disabled={disabled || !activePack} onClick={loadActive}>载入当前包</button>
        <button type="button" className="ghost-button" disabled={disabled} onClick={reset}>清空重来</button>
        <span className="action-spacer" />
        <button type="button" className="primary-button" disabled={disabled || !id.trim() || !name.trim()} onClick={submit}>安装并应用</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

