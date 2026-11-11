import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CallRoom } from "@/components/call-room";
import { isValidRoom, normalizeRoom } from "@/lib/room-name";

export default function Page({
  params,
}: {
  params: Promise<{ room: string }>;
}) {
  return (
    <Suspense fallback={<Opening />}>
      <Room params={params} />
    </Suspense>
  );
}

async function Room({ params }: { params: Promise<{ room: string }> }) {
  const { room: raw } = await params;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }

  const room = normalizeRoom(decoded);
  if (!isValidRoom(room)) {
    return (
      <main className="grid min-h-dvh place-items-center px-6 text-center">
        <div>
          <p className="font-display text-4xl">That room link is not valid.</p>
          <Link href="/" className="mt-6 inline-block text-[#d6f25c]">
            Start a new room
          </Link>
        </div>
      </main>
    );
  }

  if (room !== decoded) {
    redirect(`/call/${room}`);
  }

  return <CallRoom room={room} />;
}

function Opening() {
  return (
    <main className="grid min-h-dvh place-items-center">
      <p className="text-sm tracking-wide text-[#a3aa94]">Opening the room…</p>
    </main>
  );
}
