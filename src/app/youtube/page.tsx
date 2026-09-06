import { redirect } from "next/navigation";

// Preserve old bookmarks without maintaining a separate upload screen.
export default function YouTubePage() {
  redirect("/");
}
