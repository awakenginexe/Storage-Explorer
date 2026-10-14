use crate::{platform, scanner::ScanTree};
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, collections::HashSet};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortColumn {
    Name,
    #[default]
    Logical,
    Physical,
    Files,
    Folders,
    Modified,
    Percentage,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub root: usize,
    pub expanded: Vec<usize>,
    pub search: String,
    pub column: SortColumn,
    pub descending: bool,
    pub largest: bool,
    pub category: Option<String>,
    pub min_size: u64,
    pub location: String,
    pub offset: usize,
    pub limit: usize,
    pub revision: Option<u64>,
}

fn compare(tree: &ScanTree, q: &Query, a: usize, b: usize) -> Ordering {
    let (a, b) = (&tree.nodes[a], &tree.nodes[b]);
    if q.column == SortColumn::Physical {
        let unavailable =
            (a.unknown_physical > 0 || a.skipped).cmp(&(b.unknown_physical > 0 || b.skipped));
        if unavailable != Ordering::Equal {
            return unavailable;
        }
    }
    let order = match q.column {
        SortColumn::Name => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        SortColumn::Logical => a.logical.cmp(&b.logical),
        SortColumn::Percentage => {
            let denominator = |n: &crate::scanner::Node| {
                n.parent.map_or(n.logical, |p| tree.nodes[p].logical).max(1) as u128
            };
            (a.logical as u128 * denominator(b)).cmp(&(b.logical as u128 * denominator(a)))
        }
        SortColumn::Physical => a.physical.cmp(&b.physical),
        SortColumn::Files => a.files.cmp(&b.files),
        SortColumn::Folders => a.folders.cmp(&b.folders),
        SortColumn::Modified => a.modified.cmp(&b.modified),
    };
    let order = if q.descending { order.reverse() } else { order };
    order.then_with(|| a.name.cmp(&b.name))
}

fn sort_ids<T: Copy>(
    tree: &ScanTree,
    q: &Query,
    ids: &mut Vec<T>,
    id: impl Fn(&T) -> usize,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    const CHUNK: usize = 2048;
    for chunk in ids.chunks_mut(CHUNK) {
        check()?;
        chunk.sort_unstable_by(|a, b| compare(tree, q, id(a), id(b)));
    }
    if ids.len() <= CHUNK {
        return check();
    }
    let mut buffer = ids.clone();
    let mut width = CHUNK;
    while width < ids.len() {
        for start in (0..ids.len()).step_by(width * 2) {
            let middle = (start + width).min(ids.len());
            let end = (start + width * 2).min(ids.len());
            let (mut left, mut right) = (start, middle);
            for (offset, output) in buffer[start..end].iter_mut().enumerate() {
                if offset % 1024 == 0 {
                    check()?;
                }
                if left < middle
                    && (right == end
                        || compare(tree, q, id(&ids[left]), id(&ids[right])) != Ordering::Greater)
                {
                    *output = ids[left];
                    left += 1;
                } else {
                    *output = ids[right];
                    right += 1;
                }
            }
        }
        std::mem::swap(ids, &mut buffer);
        width *= 2;
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    check()
}

pub fn index(tree: &ScanTree, q: &Query) -> Result<Vec<(usize, usize)>, String> {
    index_cancellable(tree, q, || false)
}

pub fn index_cancellable(
    tree: &ScanTree,
    q: &Query,
    cancelled: impl Fn() -> bool,
) -> Result<Vec<(usize, usize)>, String> {
    let check = || {
        if cancelled() {
            return Err("Query replaced by a newer request.".to_string());
        }
        if platform::query_memory_pressure() {
            return Err(
                "Not enough memory to build results. Narrow the search or scan a smaller folder."
                    .to_string(),
            );
        }
        Ok(())
    };
    check()?;
    let Some(root) = tree.nodes.get(q.root).filter(|n| n.directory) else {
        return Err("Folder is no longer available in this scan.".into());
    };
    let expanded: HashSet<usize> = q.expanded.iter().copied().collect();
    let search = q.search.trim().to_lowercase();
    let location = q.location.trim().to_lowercase();
    let flat = q.largest || !search.is_empty() || !location.is_empty();
    let mut result = Vec::new();
    if flat {
        let paths = !search.is_empty() || !location.is_empty();
        let prefix = if paths {
            platform::display_path(&tree.path(q.root)).to_lowercase()
        } else {
            String::new()
        };
        // Keep one path per traversal depth, rather than rebuilding every file's ancestors.
        let mut stack = vec![(q.root, 0, prefix)];
        let mut visited = 0;
        while let Some((parent, next, prefix)) = stack.last_mut() {
            let Some(&id) = tree.nodes[*parent].children.get(*next) else {
                stack.pop();
                continue;
            };
            *next += 1;
            visited += 1;
            if visited % 1024 == 0 {
                check()?;
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            let node = &tree.nodes[id];
            let valid = (!q.largest || (!node.directory && !node.duplicate && !node.skipped))
                && q.category
                    .as_ref()
                    .is_none_or(|c| node.category.label().eq_ignore_ascii_case(c))
                && node.logical >= q.min_size;
            let path = if paths && (valid || node.directory) {
                format!(
                    "{}{sep}{}",
                    prefix.trim_end_matches(['\\', '/']),
                    node.name.to_lowercase(),
                    sep = std::path::MAIN_SEPARATOR
                )
            } else {
                String::new()
            };
            if valid && (!paths || (path.contains(&search) && path.contains(&location))) {
                result.push((id, 0));
            }
            if node.directory {
                stack.push((id, 0, path));
            }
        }
        check()?;
        sort_ids(tree, q, &mut result, |(id, _)| *id, check)?;
        check()?;
        return Ok(result);
    }
    let mut stack: Vec<_> = {
        let mut children = root.children.clone();
        sort_ids(tree, q, &mut children, |id| *id, check)?;
        children.into_iter().rev().map(|id| (id, 0)).collect()
    };
    while let Some((id, depth)) = stack.pop() {
        let node = &tree.nodes[id];
        if result.len() % 1024 == 0 {
            check()?;
        }
        result.push((id, depth));
        if expanded.contains(&id) {
            let mut children = node.children.clone();
            sort_ids(tree, q, &mut children, |id| *id, check)?;
            stack.extend(children.into_iter().rev().map(|child| (child, depth + 1)));
        }
    }
    check()?;
    Ok(result)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: usize,
    pub parent: Option<usize>,
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub depth: usize,
    pub logical: u64,
    pub physical: Option<u64>,
    pub known_physical: u64,
    pub files: u64,
    pub folders: u64,
    pub modified: u64,
    pub percentage: f64,
    pub category: String,
    pub duplicate: bool,
    pub skipped: bool,
    pub protected: bool,
    pub entry_size: u64,
}

pub fn row(tree: &ScanTree, id: usize, depth: usize) -> Row {
    let n = &tree.nodes[id];
    let path = platform::display_path(&tree.path(id));
    let protected = path.split(['\\', '/']).any(|s| {
        [
            "windows",
            "program files",
            "program files (x86)",
            "system volume information",
            "$recycle.bin",
        ]
        .iter()
        .any(|p| s.eq_ignore_ascii_case(p))
    });
    let parent_size = n.parent.map_or(n.logical, |p| tree.nodes[p].logical);
    Row {
        id,
        parent: n.parent,
        name: n.name.clone(),
        path,
        directory: n.directory,
        depth,
        logical: n.logical,
        physical: (n.unknown_physical == 0 && !n.skipped).then_some(n.physical),
        known_physical: n.physical,
        files: n.files,
        folders: n.folders,
        modified: n.modified,
        percentage: if parent_size == 0 {
            0.0
        } else {
            n.logical as f64 / parent_size as f64 * 100.0
        },
        category: n.category.label().to_lowercase(),
        duplicate: n.duplicate,
        skipped: n.skipped,
        protected,
        entry_size: n.entry_size,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub rows: Vec<Row>,
    pub total: usize,
    pub revision: u64,
    pub breadcrumbs: Vec<Row>,
}

pub fn page(tree: &ScanTree, q: &Query, index: &[(usize, usize)]) -> Page {
    let rows = index
        .iter()
        .skip(q.offset)
        .take(q.limit.clamp(1, 2000))
        .map(|(id, depth)| row(tree, *id, *depth))
        .collect();
    Page {
        rows,
        total: index.len(),
        revision: tree.revision,
        breadcrumbs: breadcrumbs(tree, q.root).unwrap_or_default(),
    }
}

pub fn breadcrumbs(tree: &ScanTree, root: usize) -> Result<Vec<Row>, String> {
    if !tree.nodes.get(root).is_some_and(|n| n.directory) {
        return Err("Folder is no longer available in this scan.".into());
    }
    let mut ancestors = Vec::new();
    let mut id = Some(root);
    while let Some(current) = id {
        ancestors.push(row(tree, current, 0));
        id = tree.nodes[current].parent;
    }
    ancestors.reverse();
    Ok(ancestors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::{Category, Node};

    fn tree() -> ScanTree {
        ScanTree {
            root: "C:/fixture".into(),
            nodes: vec![
                Node {
                    name: "root".into(),
                    directory: true,
                    children: vec![1, 2, 3],
                    logical: 150,
                    ..Node::default()
                },
                Node {
                    name: "a".into(),
                    parent: Some(0),
                    directory: true,
                    children: vec![4],
                    logical: 30,
                    physical: 4096,
                    files: 3,
                    folders: 0,
                    modified: 30,
                    ..Node::default()
                },
                Node {
                    name: "b".into(),
                    parent: Some(0),
                    logical: 50,
                    physical: 8192,
                    files: 2,
                    modified: 20,
                    ..Node::default()
                },
                Node {
                    name: "c".into(),
                    parent: Some(0),
                    logical: 70,
                    physical: 12288,
                    files: 1,
                    modified: 10,
                    ..Node::default()
                },
                Node {
                    name: "inner.mp4".into(),
                    parent: Some(1),
                    logical: 30,
                    files: 1,
                    category: Category::Videos,
                    ..Node::default()
                },
            ],
            ..ScanTree::default()
        }
    }

    #[test]
    fn sorts_every_relevant_column_in_both_directions() {
        let tree = tree();
        for (column, ascending) in [
            (SortColumn::Name, vec![1, 2, 3]),
            (SortColumn::Logical, vec![1, 2, 3]),
            (SortColumn::Physical, vec![1, 2, 3]),
            (SortColumn::Files, vec![3, 2, 1]),
            (SortColumn::Modified, vec![3, 2, 1]),
            (SortColumn::Percentage, vec![1, 2, 3]),
        ] {
            for descending in [false, true] {
                let q = Query {
                    column,
                    descending,
                    ..Query::default()
                };
                let mut expected = ascending.clone();
                if descending {
                    expected.reverse();
                }
                assert_eq!(
                    index(&tree, &q)
                        .unwrap()
                        .iter()
                        .map(|(id, _)| *id)
                        .collect::<Vec<_>>(),
                    expected,
                    "{column:?} {descending}"
                );
            }
        }
    }

    #[test]
    fn expansion_preserves_sibling_sort_and_selected_hierarchy() {
        let tree = tree();
        let q = Query {
            expanded: vec![1],
            column: SortColumn::Logical,
            descending: true,
            ..Query::default()
        };
        assert_eq!(
            index(&tree, &q).unwrap(),
            vec![(3, 0), (2, 0), (1, 0), (4, 1)]
        );
        assert_eq!(index(&tree, &Query { root: 1, ..q }).unwrap(), vec![(4, 0)]);
    }

    #[test]
    fn search_and_largest_filters_reach_collapsed_descendants() {
        let tree = tree();
        assert_eq!(
            index(
                &tree,
                &Query {
                    search: "MP4".into(),
                    ..Query::default()
                }
            )
            .unwrap(),
            vec![(4, 0)]
        );
        assert_eq!(
            index(
                &tree,
                &Query {
                    largest: true,
                    category: Some("videos".into()),
                    min_size: 25,
                    location: "fixture".into(),
                    ..Query::default()
                }
            )
            .unwrap(),
            vec![(4, 0)]
        );
        assert!(
            index(
                &tree,
                &Query {
                    largest: true,
                    min_size: 1000,
                    ..Query::default()
                }
            )
            .unwrap()
            .is_empty()
        );
    }

    #[test]
    fn superseded_search_stops_instead_of_finishing_the_index() {
        let tree = tree();
        let q = Query {
            search: "mp4".into(),
            ..Query::default()
        };
        assert!(
            index_cancellable(&tree, &q, || true)
                .unwrap_err()
                .contains("replaced")
        );
        assert_eq!(
            index_cancellable(&tree, &q, || false).unwrap(),
            index(&tree, &q).unwrap()
        );
    }

    #[test]
    fn breadcrumbs_do_not_need_a_sorted_descendant_index() {
        let tree = tree();
        let rows = breadcrumbs(&tree, 1).unwrap();
        assert_eq!(rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![0, 1]);
        assert!(breadcrumbs(&tree, 999).is_err());
        assert!(breadcrumbs(&tree, 2).is_err());
    }

    #[test]
    fn large_sorts_are_cancellable_and_keep_exact_order() {
        let mut tree = tree();
        tree.nodes.truncate(1);
        tree.nodes[0].children = (1..=5000).collect();
        for id in 1..=5000 {
            tree.nodes.push(Node {
                name: format!("{id}.bin"),
                parent: Some(0),
                logical: ((id * 7919) % 5001) as u64,
                ..Node::default()
            });
        }
        for column in [SortColumn::Logical, SortColumn::Name] {
            for descending in [true, false] {
                let q = Query {
                    column,
                    descending,
                    ..Query::default()
                };
                let actual = index(&tree, &q).unwrap();
                let mut expected = tree.nodes[0].children.clone();
                expected.sort_unstable_by(|a, b| compare(&tree, &q, *a, *b));
                assert_eq!(
                    actual.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
                    expected
                );
            }
        }
        let checks = std::cell::Cell::new(0);
        let error = index_cancellable(&tree, &Query::default(), || {
            checks.set(checks.get() + 1);
            checks.get() > 2
        })
        .unwrap_err();
        assert!(error.contains("replaced"));
        assert_eq!(checks.get(), 3);
    }

    #[test]
    fn unknown_allocation_stays_last_in_either_direction() {
        let mut tree = tree();
        tree.nodes[1].unknown_physical = 1;
        for descending in [false, true] {
            assert_eq!(
                index(
                    &tree,
                    &Query {
                        column: SortColumn::Physical,
                        descending,
                        ..Query::default()
                    }
                )
                .unwrap()
                .last(),
                Some(&(1, 0))
            );
        }
    }

    #[test]
    fn rejects_invalid_and_file_hierarchies() {
        let tree = tree();
        assert!(
            index(
                &tree,
                &Query {
                    root: 999,
                    ..Query::default()
                }
            )
            .is_err()
        );
        assert!(
            index(
                &tree,
                &Query {
                    root: 2,
                    ..Query::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn pages_a_hundred_thousand_sorted_entries_without_losing_boundaries() {
        let mut tree = tree();
        tree.nodes.truncate(1);
        tree.nodes[0].children = (1..=100_000).collect();
        for id in 1..=100_000 {
            tree.nodes.push(Node {
                name: format!("{id}.bin"),
                parent: Some(0),
                logical: id as u64,
                ..Node::default()
            });
        }
        let q = Query {
            descending: true,
            offset: 99_990,
            limit: 256,
            ..Query::default()
        };
        let result = page(&tree, &q, &index(&tree, &q).unwrap());
        assert_eq!(result.total, 100_000);
        assert_eq!(result.rows.len(), 10);
        assert_eq!(result.rows[0].logical, 10);
        assert_eq!(result.rows[9].logical, 1);
        assert_eq!(result.breadcrumbs.len(), 1);
    }
}
