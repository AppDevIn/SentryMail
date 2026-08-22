//! Reciprocal Rank Fusion (ADR 0003): merges ranked candidate lists by rank alone, so
//! BM25 and cosine scores never need calibrating against each other.

/// One fused result: `sources` holds the indices (into the input slice) of every list
/// that contained `id`, in input order.
#[derive(Debug, Clone, PartialEq)]
pub struct FusedHit {
    pub id: i64,
    pub score: f32,
    pub sources: Vec<usize>,
}

/// `score = sum over lists of 1 / (k + rank)` with 1-based ranks, sorted by score
/// descending. Ties keep first-seen order (list 0 before list 1, earlier rank first),
/// so the sort is deterministic.
pub fn rrf(lists: &[Vec<i64>], k: u32) -> Vec<FusedHit> {
    let mut hits: Vec<FusedHit> = Vec::new();
    for (source, list) in lists.iter().enumerate() {
        for (i, &id) in list.iter().enumerate() {
            let contribution = 1.0 / (k as f32 + (i + 1) as f32);
            match hits.iter_mut().find(|h| h.id == id) {
                Some(hit) => {
                    hit.score += contribution;
                    if !hit.sources.contains(&source) {
                        hit.sources.push(source);
                    }
                }
                None => hits.push(FusedHit {
                    id,
                    score: contribution,
                    sources: vec![source],
                }),
            }
        }
    }
    // Stable sort: equal scores keep insertion order.
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(hits: &[FusedHit]) -> Vec<i64> {
        hits.iter().map(|h| h.id).collect()
    }

    #[test]
    fn single_list_preserves_order() {
        let hits = rrf(&[vec![10, 20, 30]], 60);
        assert_eq!(ids(&hits), vec![10, 20, 30]);
        assert!(hits.iter().all(|h| h.sources == vec![0]));
    }

    #[test]
    fn item_in_both_lists_outranks_single_source() {
        let hits = rrf(&[vec![1, 2, 3], vec![4, 3]], 60);
        assert_eq!(hits[0].id, 3);
        assert_eq!(hits[0].sources, vec![0, 1]);
        assert!((hits[0].score - (1.0 / 63.0 + 1.0 / 62.0)).abs() < 1e-6);
    }

    #[test]
    fn ties_keep_first_seen_order() {
        // Rank 1 in list 0 and rank 1 in list 1 score identically; list 0 wins the tie.
        let hits = rrf(&[vec![7], vec![8]], 60);
        assert_eq!(ids(&hits), vec![7, 8]);
        let hits = rrf(&[vec![8], vec![7]], 60);
        assert_eq!(ids(&hits), vec![8, 7]);
    }

    #[test]
    fn empty_lists_yield_nothing() {
        assert!(rrf(&[vec![], vec![]], 60).is_empty());
        assert!(rrf(&[], 60).is_empty());
    }
}
