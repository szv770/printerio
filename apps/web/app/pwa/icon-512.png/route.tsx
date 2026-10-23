import { pwaIconResponse } from "@/lib/pwa/icon-image";

export function GET() {
  return pwaIconResponse(512, "any");
}
