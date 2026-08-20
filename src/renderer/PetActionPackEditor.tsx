import { useEffect, useMemo, useState } from "react";
import {
  idlePetActions,
  petActionLabels,
  type PetIdleAction,
} from "./pet-behavior";
import {
  type InstalledPetActionPack,
  validatePetActionPack,
} from "./pet-action-packs";

export interface PetActionPackEditorProps {
  activePack?: InstalledPetActionPack;
  disabled?: boolean;
  onInstall: (pack: InstalledPetActionPack) => void;
}

const defaultActions: PetIdleAction[] = ["idle", "stretch", "read", "drink", "peek"];

/**
 * A safe visual editor for declarative action packs. It only emits the same
 * validated shape accepted by the JSON importer; no script or external asset
 * can enter the renderer through this surface.
 */
export function PetActionPackEditor({
  activePack,
  disabled = false,
  onInstall,
}: PetActionPackEditorProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<PetIdleAction[]>(defaultActions);
  const [error, setError] = useState("");

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const reset = () => {
    setId("");
    setName("");
    setDescription("");
    setSelected(defaultActions);
    setError("");
  };

  const loadActive = () => {
    if (!activePack) return;
    setId(activePack.id);
    setName(activePack.name);
    setDescription(activePack.description);
    setSelected([...activePack.idleActions]);
    setError("");
  };

  useEffect(() => {
    if (!activePack) return;
    // Keep the editor useful after selecting a pack in the adjacent picker,
    // but do not overwrite edits already being made in the form.
    if (!id && !name) loadActive();
    // The selected pack identity is the only dependency that should trigger
    // this synchronization; the form fields intentionally remain local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePack?.id]);

  const toggle = (action: PetIdleAction) => {
    setSelected((current) => {
      if (current.includes(action)) {
        if (current.length <= 1) return current;
        return current.filter((item) => item !== action);
      }
      if (current.length >= 20) return current;
      return [...current, action];
    });
    setError("");
  };

  const submit = () => {
    const result = validatePetActionPack({
      id,
      name,
      description,
      idleActions: selected,
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onInstall(result.pack);
    setError("");
  };

  return (
    <div className="pet-action-pack-editor" aria-label="动作包可视化编辑器">
      <div className="pet-action-pack-editor-heading">
        <div>
          <strong>可视化编辑器</strong>
          <p>勾选已有动作，组合一个只在本机运行的陪伴节奏。</p>
        </div>
        <span>{selected.length}/20</span>
      </div>
      <div className="pet-action-pack-editor-fields">
        <label>
          <span>包 ID</span>
          <input
            className="settings-input"
            value={id}
            disabled={disabled}
            onChange={(event) => { setId(event.target.value); setError(""); }}
            placeholder="cozy-reading"
            maxLength={40}
          />
        </label>
        <label>
          <span>名称</span>
          <input
            className="settings-input"
            value={name}
            disabled={disabled}
            onChange={(event) => { setName(event.target.value); setError(""); }}
            placeholder="安静阅读"
            maxLength={40}
          />
        </label>
      </div>
      <label className="pet-action-pack-editor-description">
        <span>说明</span>
        <input
          className="settings-input"
          value={description}
          disabled={disabled}
          onChange={(event) => { setDescription(event.target.value); setError(""); }}
          placeholder="更多阅读和休息动作"
          maxLength={160}
        />
      </label>
      <div className="pet-action-pack-action-grid" role="group" aria-label="选择待机动作">
        {idlePetActions.map((action) => (
          <label className={`pet-action-pack-action ${selectedSet.has(action) ? "is-selected" : ""}`} key={action}>
            <input
              type="checkbox"
              checked={selectedSet.has(action)}
              disabled={disabled || (selectedSet.has(action) && selected.length <= 1)}
              onChange={() => toggle(action)}
            />
            <span>{petActionLabels[action]}</span>
          </label>
        ))}
      </div>
      <div className="settings-actions pet-action-pack-editor-actions">
        <button type="button" className="soft-button" disabled={disabled || !activePack} onClick={loadActive}>载入当前包</button>
        <button type="button" className="ghost-button" disabled={disabled} onClick={reset}>清空重来</button>
        <span className="action-spacer" />
        <button type="button" className="primary-button" disabled={disabled || !id.trim() || !name.trim()} onClick={submit}>安装并启用</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
