import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { TopBar } from "../components/TopBar";
import { Stars } from "../components/Stars";
import { getPlace, loadPlaces, loadReviews } from "../lib/data";
import { store } from "../lib/store";
import type { Place, Review } from "../types";

export function Reviews() {
  const { id } = useParams();
  const nav = useNavigate();
  const [place, setPlace] = useState<Place | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<Review[]>([]);
  const [rating, setRating] = useState(5);
  const [text, setText] = useState("");

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setPlace(null);
    setRows([]);
    if (!id) {
      setLoaded(true);
      return () => {
        active = false;
      };
    }
    Promise.all([loadPlaces(), loadReviews()])
      .then(([places, crm]) => {
        if (!active) return;
        setPlace(getPlace(places, id) ?? null);
        const local = store.get().reviews.filter((review) => review.placeId === id);
        const merged = new Map(crm.filter((review) => review.placeId === id).map((review) => [review.id, review]));
        for (const review of local) merged.set(review.id, review);
        setRows(Array.from(merged.values()).sort((a, b) => b.createdAt - a.createdAt));
      })
      .catch(() => {
        if (active) setPlace(null);
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (!place) return <div className="empty">{loaded ? "Place not found." : "Loading…"}</div>;

  return (
    <div className="page">
      <TopBar title="Reviews" />
      <div className="section">
        <div className="place-name">{place.name}</div>
        <Stars value={place.rating} count={place.reviews + rows.length} />
        <h3>Write a local review</h3>
        <div className="filters">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={`chip ${rating === n ? "on" : ""}`} onClick={() => setRating(n)}>
              {n}
            </button>
          ))}
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="How was the stop?" />
        <button
          className="btn blue"
          style={{ marginTop: 10 }}
          onClick={() => {
            const user = store.get().user;
            if (!user) {
              nav("/login");
              return;
            }
            if (!text.trim()) return;
            const review: Review = {
              id: crypto.randomUUID(),
              placeId: place.id,
              userId: user.id,
              name: user.name,
              rating,
              text: text.trim(),
              createdAt: Date.now(),
            };
            const local = store.addReview(review).filter((r) => r.placeId === place.id);
            setRows((prev) => {
              const crm = prev.filter((r) => !local.some((l) => l.id === r.id));
              return [...local, ...crm];
            });
            setText("");
          }}
        >
          Save on this device
        </button>
        <h3>All reviews</h3>
        {rows.length === 0 && <p className="muted">No rider reviews yet. Google score: {place.rating ?? "n/a"}.</p>}
        {rows.map((r) => (
          <div key={r.id} style={{ padding: "10px 0", borderBottom: "1px solid #222" }}>
            <b>{r.name}</b> <Stars value={r.rating} />
            <p>{r.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
