//! Path text helpers on bytes, as `kernel/vfs/path.ts` does them on strings: no
//! lookups. A path splits into parts at every `/`, exactly as `split("/")`.

pub const SLASH: u8 = b'/';

/// Where the part that starts at `start` ends: at the next slash, or at the end.
pub fn part_end(text: &[u8], start: usize) -> usize {
    match text[start..].iter().position(|&byte| byte == SLASH) {
        Some(offset) => start + offset,
        None => text.len(),
    }
}

/// The byte range of the last part that is not empty or `.`
/// (`lastComponentIndex`), or None when there is none.
pub fn last_component(text: &[u8]) -> Option<(usize, usize)> {
    let mut stop = text.len();
    loop {
        let start = match text[..stop].iter().rposition(|&byte| byte == SLASH) {
            Some(slash) => slash + 1,
            None => 0,
        };
        let part = &text[start..stop];
        if !part.is_empty() && part != b"." {
            return Some((start, stop));
        }
        if start == 0 {
            return None;
        }
        stop = start - 1;
    }
}

/// The last part of `path` as written, trailing slashes ignored (`.` and
/// `..` included); empty for `/`.
pub fn last_part(path: &[u8]) -> &[u8] {
    let trimmed = trim_trailing_slashes(path);
    match trimmed.iter().rposition(|&byte| byte == SLASH) {
        Some(cut) => &trimmed[cut + 1..],
        None => trimmed,
    }
}

/// `path` without trailing slashes; `/` stays `/`.
pub fn trim_trailing_slashes(path: &[u8]) -> &[u8] {
    let mut end = path.len();
    while end > 1 && path[end - 1] == SLASH {
        end -= 1;
    }
    &path[..end]
}

/// The parent of `path` by its text alone, as `mkdir -p` walks upward:
/// trailing slashes are ignored and `/` is its own parent.
pub fn lexical_parent(path: &[u8]) -> &[u8] {
    let trimmed = trim_trailing_slashes(path);
    match trimmed.iter().rposition(|&byte| byte == SLASH) {
        Some(cut) if cut > 0 => trim_trailing_slashes(&trimmed[..cut]),
        _ => b"/",
    }
}
