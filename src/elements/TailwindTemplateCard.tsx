import { render } from "preact";
import { HaCard } from "@components/HaCard";

// support shadowroot.adoptedStyleSheets in all browsers
import "construct-style-sheets-polyfill";
import { TailwindTemplateRenderer } from "./TailwindTemplateRenderer";
import { initialConfigState } from "@store/ConfigReducer";
import { Action, Binding } from "@types";
import { HomeAssistant } from "custom-card-helpers";
import _ from "lodash";

type Unsubscribe = () => Promise<void>;

// One live render_template subscription. Home Assistant re-renders the template on its own whenever an entity
// it uses changes (and every minute for now()), and pushes each new result to it, so a card needs exactly one
// per template while it is on the page.
interface TemplateSubscription {
  template: string;
  connection: HomeAssistant["connection"];
  unsubscribe: Promise<Unsubscribe>;
  active: boolean;
  rendered: boolean;
}

console.info(
  `%c  TailwindCSS Template Card  \n%c  Version ${CARD_VERSION}  \n%c  Star it at http://github.com/usernein/tailwindcss-template-card!`,
  "color: #2d2c35; font-weight: bold; background: #f5f6f9",
  "color: #aef3fc; font-weight: bold; background: #2d2c35",
  "color: #aef3fc; font-weight: bold; background: #2d2c35",
);

export class TailwindTemplateCard extends TailwindTemplateRenderer {
  _entitiesToWatch: string[] = [];
  _htmlContent: string = "";
  _templateSubscription: TemplateSubscription | undefined;
  // Classes each element got from "class" bindings, so the next run can take them off again.
  _boundClasses = new WeakMap<Element, Map<number, string>>();

  constructor() {
    super();
  }

  connectedCallback() {
    // Back on the page (first time, or after switching views): start listening again.
    if (this._hass && this._config?.content !== undefined) {
      this.processAndRender(true);
    }
  }

  disconnectedCallback() {
    // Off the page: stop Home Assistant rendering this card's template for nobody.
    this.unsubscribeTemplate();
  }

  static getConfigElement() {
    return document.createElement("tailwindcss-template-card-config");
  }

  static getStubConfig() {
    return initialConfigState;
  }

  updateEntitiesToWatch() {
    this._entitiesToWatch = [];

    if (this._config.entity) {
      this._entitiesToWatch.push(this._config.entity);
    }

    if (this._config.entities && Array.isArray(this._config.entities)) {
      this._config.entities.forEach((entity: string) => {
        this._entitiesToWatch.push(entity);
      });
    }

    this.watchMentionedEntities();
  }

  watchMentionedEntities() {
    if (!this._hass || !this._config || this._config.content === undefined)
      return;

    Object.keys(this._hass.states).forEach((entity_id: string) => {
      if (!this._hass || !this._config || this._config.content === undefined) {
        return false;
      }

      const content = this._config.content;

      if (
        content.includes(entity_id) ||
        this.checkIfEntityIsUsedByBinding(entity_id)
      ) {
        this._entitiesToWatch.push(entity_id);
      }
    });
  }

  checkIfEntityIsUsedByBinding(entity_id: string) {
    if (!this._hass || !this._config || this._config.content === undefined) {
      return null;
    }

    for (const binding of this._config.bindings) {
      if (binding.bind.includes(entity_id)) {
        return true;
      }
    }
    return false;
  }

  renderIfNeeded(forceUpdate?: boolean) {
    if (forceUpdate || this.needsRender()) {
      this.processAndRender(forceUpdate);
    }
  }

  needsRender() {
    if (!this._hass || !this._oldHass) {
      console.debug("needsRender: no hass");
      return true;
    }
    if (!this._entitiesToWatch) {
      console.debug("needsRender: no entities to watch");
      return true;
    }

    if (this._config.always_update) {
      console.debug("needsRender: always_update");
      return true;
    }

    // if (!_.isEqual(this._oldConfig["bindings"], this._config["bindings"])) {
    //   console.debug("needsRender: bindings changed");
    //
    //   return true;
    // }

    for (const entity_id of this._entitiesToWatch) {
      if (!this._hass.states[entity_id]) continue;
      if (
        !_.isEqual(
          this._oldHass.states[entity_id],
          this._hass.states[entity_id],
        ) ||
        !_.isEqual(
          this._oldHass.states[entity_id].attributes,
          this._hass.states[entity_id].attributes,
        )
      ) {
        console.debug("needsRender: entity changed", entity_id);
        return true;
      }
    }

    return false;
  }

  getCardSize() {
    return 1;
  }

  processAndRender(forceRender?: boolean) {
    if (!this._hass || !this._config || this._config.content == undefined)
      return;

    let content = this._config.content;

    if (
      undefined !== this._config.ignore_line_breaks &&
      !this._config.ignore_line_breaks
    ) {
      content = content.replace(/\r?\n|\r/g, "</br>");
    }

    if (!this._config.parse_jinja) {
      this.unsubscribeTemplate();
      this._htmlContent = content;
      this._renderHtmlContent();
      return;
    }

    const current = this._templateSubscription;
    if (
      current &&
      current.template === content &&
      current.connection === this._hass.connection
    ) {
      // Already subscribed: Home Assistant sends new HTML by itself when the template's result changes.
      // A changed entity only needs the bindings run again, and a new config (actions, plugins) a re-render.
      if (!current.rendered) return;
      if (forceRender) this._renderHtmlContent();
      else this.applyBindings();
      return;
    }

    this.subscribeTemplate(content);
  }

  subscribeTemplate(template: string) {
    this.unsubscribeTemplate();
    // Cards are set up before they are added to the page; connectedCallback subscribes then.
    if (!this._hass || !this.isConnected) return;

    const connection = this._hass.connection;
    const subscription = {
      template,
      connection,
      active: true,
      rendered: false,
    } as TemplateSubscription;

    subscription.unsubscribe = connection.subscribeMessage(
      (msg: { result: string }) => {
        if (!subscription.active) return;
        if (subscription.rendered && msg.result === this._htmlContent) {
          this.applyBindings();
          return;
        }
        subscription.rendered = true;
        this._htmlContent = msg.result;
        this._renderHtmlContent();
      },
      {
        type: "render_template",
        template,
      },
    );
    subscription.unsubscribe.catch((err: unknown) => {
      // Kept as the current subscription, so a broken template is not retried on every entity change,
      // only when the template or the connection changes.
      if (subscription.active) {
        console.error("tailwindcss-template-card: template failed", err);
      }
    });

    this._templateSubscription = subscription;
  }

  unsubscribeTemplate() {
    const subscription = this._templateSubscription;
    if (!subscription) return;

    this._templateSubscription = undefined;
    subscription.active = false;
    subscription.unsubscribe
      .then((unsubscribe) => unsubscribe())
      .catch(() => {
        // It never started (template error) or the connection is gone: nothing left to stop.
      });
  }

  _render(forceRender?: boolean) {
    this.updateEntitiesToWatch();
    this.renderIfNeeded(forceRender);
  }

  _renderHtmlContent() {
    this.ensureIsReadyForRender();

    this._deRender();
    render(
      <HaCard
        htmlContent={this._htmlContent}
        config={this._config}
        onEvent={(e) => this.handleActions(e)}
      />,
      this.shadow,
    );

    this.applyBindings();
  }

  ensureIsReadyForRender() {
    if (!this._hass) {
      throw new Error("this._hass is invalid");
    }
    if (this._config === undefined) {
      throw new Error("this.config is invalid");
    }
    if (this._config.content === undefined) {
      throw new Error("this.config.content is invalid");
    }
    if (!this.shadow) {
      throw new Error("this.shadow is invalid");
    }
  }

  applyBindings() {
    if (!this._config?.bindings) return;

    this._config.bindings.forEach((binding: Binding, index: number) => {
      if (!binding.selector || !binding.bind || !binding.type) return;
      const matches = this.shadow.querySelectorAll(binding.selector);

      matches.forEach((match) => {
        const result = this.resolveBindValue(match, binding.bind);
        const target = match as HTMLElement;
        const targetAsInput = target as HTMLInputElement;

        switch (binding.type) {
          case "text":
            target.innerText = result;
            break;
          case "html":
            target.innerHTML = result;
            break;
          case "class": {
            // Bindings now also run when an entity changes without a re-render, so swap the class this
            // binding added last time instead of piling classes up.
            let added = this._boundClasses.get(target);
            if (!added) {
              added = new Map();
              this._boundClasses.set(target, added);
            }
            const previous = added.get(index);
            if (previous && previous !== result) target.classList.remove(previous);
            if (result) {
              target.classList.add(result);
              added.set(index, result);
            } else {
              added.delete(index);
            }
            break;
          }
          case "checked":
            targetAsInput.checked = Boolean(result);
            break;
          case "value":
            targetAsInput.value = result;
            break;
          default:
            if (typeof result === "undefined" || "" === `${result}`) {
              target.removeAttribute(binding.type);
            } else {
              target.setAttribute(binding.type, result);
            }
            break;
        }
      });
    });
  }

  handleActions(e: Event) {
    if (!this._config?.actions || !e.target) return;

    const hass = this._hass;
    const config = this._config;
    const entity_id = config.entity;

    if (!hass) return;

    const entity = { ...hass.states[entity_id] } as {
      [key: string]: CallableFunction;
    } & HomeAssistant["states"][string];

    if (entity_id) {
      const [domain] = entity_id.split(".");
      const services = hass.services[domain];
      for (const service in services) {
        entity[service] = (data: object) =>
          hass.callService(domain, service, { entity_id, ...data });
      }
    }

    this._config.actions.forEach(({ call, selector, type }: Action) => {
      if (!selector || !call || !type) return;

      const target = e.target as HTMLElement;

      if (type === e.type && target.matches(selector)) {
        const executeCall = new Function("hass", "config", "entity", call);
        executeCall.call(e.target, hass, config, entity);
      }
    });
  }

  resolveBindValue(element: Element, bind: string) {
    if (!this._hass) return;
    const entity = this._hass.states[this._config.entity];

    try {
      const getState = new Function(
        "hass",
        "config",
        "entity",
        "state",
        "attr",
        bind,
      );
      return getState.call(
        element,
        this._hass,
        this._config,
        entity,
        entity ? entity.state : undefined,
        entity ? entity.attributes : undefined,
      );
    } catch (e) {
      console.log("BINDING --> FAILED", bind);
    }
  }
}
