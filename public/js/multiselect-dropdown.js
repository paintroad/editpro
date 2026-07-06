(function initMultiselectDropdown(global) {
  const openInstances = new Set();

  function closeAllExcept(instance) {
    for (const other of openInstances) {
      if (other !== instance) {
        other.close();
      }
    }
  }

  class MultiselectDropdown {
    constructor(containerEl, options = {}) {
      if (!containerEl) {
        throw new Error("MultiselectDropdown requires a container element.");
      }
      this.container = containerEl;
      this.placeholder = options.placeholder || "Select";
      this.options = Array.isArray(options.options) ? options.options : [];
      this.onChange = typeof options.onChange === "function" ? options.onChange : null;
      this.selected = new Set(
        Array.isArray(options.values) ? options.values : [...(options.values || [])]
      );
      this.isOpen = false;
      this.render();
      this.bindEvents();
      this.updateTriggerLabel();
    }

    render() {
      this.container.classList.add("ms-dropdown");
      this.container.innerHTML = "";

      this.trigger = document.createElement("button");
      this.trigger.type = "button";
      this.trigger.className = "ms-dropdown-trigger";
      this.trigger.setAttribute("aria-haspopup", "listbox");
      this.trigger.setAttribute("aria-expanded", "false");

      this.labelEl = document.createElement("span");
      this.labelEl.className = "ms-dropdown-label is-placeholder";
      this.labelEl.textContent = this.placeholder;

      this.chevron = document.createElement("span");
      this.chevron.className = "ms-dropdown-chevron";
      this.chevron.setAttribute("aria-hidden", "true");

      this.trigger.append(this.labelEl, this.chevron);

      this.panel = document.createElement("div");
      this.panel.className = "ms-dropdown-panel";
      this.panel.hidden = true;
      this.panel.setAttribute("role", "listbox");

      for (const option of this.options) {
        const row = document.createElement("label");
        row.className = "ms-dropdown-option";
        row.setAttribute("role", "option");

        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = option.value;
        input.checked = this.selected.has(option.value);

        const text = document.createElement("span");
        text.className = "ms-dropdown-option-label";
        text.textContent = option.label;

        row.append(input, text);
        this.panel.append(row);
      }

      this.container.append(this.trigger, this.panel);
    }

    bindEvents() {
      this.trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        this.toggle();
      });

      this.panel.addEventListener("change", (event) => {
        const input = event.target;
        if (!input || input.type !== "checkbox") {
          return;
        }
        if (input.checked) {
          this.selected.add(input.value);
        } else {
          this.selected.delete(input.value);
        }
        this.updateTriggerLabel();
        if (this.onChange) {
          this.onChange(this.getValues());
        }
      });

      this.handleDocumentClick = (event) => {
        if (!this.container.contains(event.target)) {
          this.close();
        }
      };

      this.handleDocumentKeydown = (event) => {
        if (event.key === "Escape") {
          this.close();
        }
      };
    }

    getValues() {
      return new Set(this.selected);
    }

    setValues(values) {
      this.selected = new Set(values || []);
      for (const input of this.panel.querySelectorAll('input[type="checkbox"]')) {
        input.checked = this.selected.has(input.value);
      }
      this.updateTriggerLabel();
    }

    updateTriggerLabel() {
      const count = this.selected.size;
      if (!count) {
        this.labelEl.textContent = this.placeholder;
        this.labelEl.classList.add("is-placeholder");
        return;
      }

      this.labelEl.classList.remove("is-placeholder");
      if (count === 1) {
        const value = [...this.selected][0];
        const match = this.options.find((option) => option.value === value);
        this.labelEl.textContent = match ? match.label : value;
        return;
      }

      this.labelEl.textContent = `${count} selected`;
    }

    open() {
      if (this.isOpen) {
        return;
      }
      closeAllExcept(this);
      this.isOpen = true;
      this.panel.hidden = false;
      this.trigger.setAttribute("aria-expanded", "true");
      openInstances.add(this);
      document.addEventListener("click", this.handleDocumentClick);
      document.addEventListener("keydown", this.handleDocumentKeydown);
    }

    close() {
      if (!this.isOpen) {
        return;
      }
      this.isOpen = false;
      this.panel.hidden = true;
      this.trigger.setAttribute("aria-expanded", "false");
      openInstances.delete(this);
      document.removeEventListener("click", this.handleDocumentClick);
      document.removeEventListener("keydown", this.handleDocumentKeydown);
    }

    toggle() {
      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
    }

    destroy() {
      this.close();
      this.container.innerHTML = "";
      this.container.classList.remove("ms-dropdown");
    }
  }

  global.MultiselectDropdown = MultiselectDropdown;
})(window);
