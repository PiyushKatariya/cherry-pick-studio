// =============================================================================
// frontend/combo.js
// A searchable dropdown attached to a text input.
//
// A native <datalist> gives no visible highlight while arrowing through options,
// so users can't tell what is selected. This owns the keyboard, mouse and ARIA
// mechanics once; each caller supplies only how a row looks and what a choice
// does. Used by both the repository picker and the branch picker.
//
// window.Combo.create(opts) -> { setData, refresh, open, toggle, hide, isOpen }
//   input      : the <input type=text>
//   listBox    : the <ul role=listbox> to populate
//   container  : element wrapping both — a click outside it closes the list
//   idPrefix   : id stem for options, for aria-activedescendant
//   emptyText  : shown when nothing matches
//   renderRow  : (item, index) -> inner HTML for one row. Elements carrying
//                data-act="name" become buttons that fire onAction instead of
//                selecting the row.
//   matches    : (item, lowercasedQuery) -> boolean
//   onChoose   : (item, index) -> void
//   onAction   : (actionName, item, index) -> void
// =============================================================================
(function () {
  'use strict';

  function createCombo(opts) {
    const input = opts.input;
    const listBox = opts.listBox;
    const container = opts.container;
    const idPrefix = opts.idPrefix || 'comboOpt';
    const emptyText = opts.emptyText || 'No match';
    const renderRow = opts.renderRow || ((item) => String(item));
    const matches = opts.matches || ((item, q) => String(item).toLowerCase().includes(q));
    const onChoose = opts.onChoose || (() => {});
    const onAction = opts.onAction || (() => {});

    let all = [];      // every item
    let shown = [];    // current filtered subset
    let active = -1;   // highlighted index within `shown`
    let open = false;

    const filtered = () => {
      const q = input.value.trim().toLowerCase();
      return q ? all.filter((item) => matches(item, q)) : all.slice();
    };

    function render() {
      listBox.innerHTML = shown.length
        ? shown
            .map(
              (item, i) =>
                `<li role="option" id="${idPrefix}${i}" class="${i === active ? 'active' : ''}" ` +
                `aria-selected="${i === active}">${renderRow(item, i)}</li>`
            )
            .join('')
        : `<li class="empty" aria-disabled="true">${emptyText}</li>`;
      const el = listBox.querySelector('li.active');
      if (el) el.scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', active >= 0 ? `${idPrefix}${active}` : '');
    }

    function openList(resetActive) {
      if (!all.length || input.disabled) return; // no data / locked → plain text box
      shown = filtered();
      active = resetActive ? (shown.length ? 0 : -1) : Math.min(active, shown.length - 1);
      render();
      listBox.classList.remove('hidden');
      input.setAttribute('aria-expanded', 'true');
      open = true;
    }

    function hide() {
      listBox.classList.add('hidden');
      input.setAttribute('aria-expanded', 'false');
      open = false;
      active = -1;
    }

    function choose(i) {
      if (i < 0 || i >= shown.length) return;
      onChoose(shown[i], i);
    }

    function move(delta) {
      if (!open) { openList(true); return; }
      if (!shown.length) return;
      active = (active + delta + shown.length) % shown.length;
      render();
    }

    input.addEventListener('focus', () => openList(true));
    input.addEventListener('input', () => openList(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { if (open && active >= 0) { e.preventDefault(); choose(active); } }
      else if (e.key === 'Escape') { if (open) { e.preventDefault(); hide(); } }
    });

    // mousedown, not click, so a selection lands before the input's blur closes
    // the list out from under the pointer.
    listBox.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[role=option]');
      if (!li) return;
      e.preventDefault();
      const i = [...listBox.children].indexOf(li);
      const actionEl = e.target.closest('[data-act]');
      if (actionEl) return onAction(actionEl.dataset.act, shown[i], i);
      choose(i);
    });

    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) hide();
    });

    return {
      setData: (items) => { all = items || []; },
      // Re-render in place when the data changed while the list is open — e.g. a
      // pin toggle reordered it. Without this every row action would close the list.
      refresh: () => { if (open) openList(false); },
      open: () => openList(true),
      toggle: () => { if (open) hide(); else openList(true); },
      hide,
      isOpen: () => open,
    };
  }

  window.Combo = { create: createCombo };
})();
