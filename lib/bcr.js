// Seller Central "Brand Customer Reviews" internal API.
// Found by watching the reviews page on 2026-11-18. The page itself calls:
//   /brandcustomerreviews/api/reviews?pageId=0&pageSize=50
//     &sortByType=REVIEW_CREATED_DATE&isAscending=false&includeDone=true
// Response: { totalReviewCount, totalPageCount, pageId, pageSize, reviews: [...] }
//
// Limits seen:
//   - Only the last ~90 days of reviews.
//   - At most 1,000 per sort direction (pageId 0-19 with 50 per page;
//     pageId 20 returns HTTP 400). So when there are more than 1,000 we
//     also read oldest-first to get the rest.

export const API_PATH = '/brandcustomerreviews/api/reviews';
export const PAGE_SIZE = 50;
export const MAX_PAGES_PER_DIRECTION = 20;

export function apiUrl(base, pageId, ascending) {
  const u = new URL(API_PATH, base);
  u.searchParams.set('pageId', String(pageId));
  u.searchParams.set('pageSize', String(PAGE_SIZE));
  u.searchParams.set('sortByType', 'REVIEW_CREATED_DATE');
  u.searchParams.set('isAscending', String(ascending));
  u.searchParams.set('includeDone', 'true');
  return u.toString();
}

const bool = (v) => (v === true ? 1 : v === false ? 0 : null);
const s = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// One API review -> one database row. The reviewer's name
// (reviewAuthorPublicName) is deliberately NOT kept.
export function toRow(r) {
  if (!r || typeof r.reviewId !== 'string') return null;
  const ts = s(r.reviewCreatedTimestamp);
  return {
    review_id: r.reviewId,
    review_ts: ts,
    review_date: ts ? ts.slice(0, 10) : null,
    rating: Number.isFinite(r.reviewRating) ? r.reviewRating : null,
    title: s(r.reviewTitle),
    body: s(r.reviewText),
    parent_asin: s(r.asin),
    child_asin: s(r.childAsin),
    product_title: s(r.asinTitle),
    brand: s(r.brandName),
    verified: bool(r.reviewIsVerifiedPurchase),
    vine: bool(r.reviewIsVineReview),
    has_images: bool(r.reviewHasImages),
    has_video: bool(r.reviewIsVideo),
    replied: bool(r.reviewIsRepliedTo),
    marked_done: bool(r.reviewMarkedAsDone),
  };
}

export function rowsFromResponse(json) {
  const list = Array.isArray(json?.reviews) ? json.reviews : [];
  return list.map(toRow).filter(Boolean);
}
