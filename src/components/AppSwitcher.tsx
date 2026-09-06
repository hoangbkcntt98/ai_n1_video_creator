"use client";

export default function AppSwitcher() {
  return <label className="appSwitcher"><span>Application</span><select defaultValue="/video-creator" onChange={(event) => { window.location.href = event.target.value; }}>
    <option value="/manga-web">Manga Web</option>
    <option value="/video-creator">Video Creator</option>
  </select></label>;
}
