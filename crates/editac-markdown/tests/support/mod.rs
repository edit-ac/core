// Only normalize documented renderer spelling differences, not source or code.
pub fn gfm_html(s: &str) -> String {
    let mut s = s.replace("&quot;", "\"");
    for alignment in ["left", "center", "right"] {
        s = s.replace(
            &format!("style=\"text-align: {alignment}\""),
            &format!("align=\"{alignment}\""),
        );
    }
    s = s.replace(
        "<input disabled=\"\" type=\"checkbox\" checked=\"\"/>",
        "<input checked=\"\" disabled=\"\" type=\"checkbox\">",
    );
    s = s.replace(
        "<input disabled=\"\" type=\"checkbox\"/>",
        "<input disabled=\"\" type=\"checkbox\">",
    );
    s = s.replace("type=\"checkbox\">\n", "type=\"checkbox\"> ");
    for tag in ["table", "thead", "tbody", "tr", "th", "td"] {
        s = s.replace(&format!("<{tag}>\n"), &format!("<{tag}>"));
        s = s.replace(&format!("</{tag}>\n"), &format!("</{tag}>"));
    }
    // Alignment attributes are the only attributes on table cells in this corpus.
    s = s
        .replace("align=\"left\">\n", "align=\"left\">")
        .replace("align=\"center\">\n", "align=\"center\">")
        .replace("align=\"right\">\n", "align=\"right\">");
    // An empty table body adds no rows/cells in either renderer.
    s.replace("<tbody></tbody>", "")
}
