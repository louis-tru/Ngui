/* ***** BEGIN LICENSE BLOCK *****
 * Distributed under the BSD license:
 *
 * Copyright © 2015-2016, xuewen.chu
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *     * Redistributions of source code must retain the above copyright
 *       notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above copyright
 *       notice, this list of conditions and the following disclaimer in the
 *       documentation and/or other materials provided with the distribution.
 *     * Neither the name of xuewen.chu nor the
 *       names of its contributors may be used to endorse or promote products
 *       derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL xuewen.chu BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * ***** END LICENSE BLOCK ***** */

import utils from './util';
import { StyleSheet } from './css';
import event, { Notification, EventNoticer, Listen, Event } from './event';
import { TextNode, View, DOM } from './_view';

const TEXT_NODE_VALUE_TYPE = new Set(['function', 'string', 'number', 'boolean']);
const G_removeSet = new WeakSet<ViewController>();
const G_renderQueueSet = new Set<ViewController>();
var   G_renderQueueWorking = false;
const G_warnRecord = new Set();
const G_warnDefine = {
	UndefinedDOMKey: 'DOM key no defined in DOM Collection',
} as Dict<string>;

function warn(id: string, msg = '') {
	var def = G_warnDefine[id];
	if (def) {
		if (!G_warnRecord.has(id)) {
			G_warnRecord.add(id);
			console.warn(def, msg);
		}
	}
}

// mark controller rerender
function markRerender(ctr: ViewController) {
	var size = G_renderQueueSet.size;
	G_renderQueueSet.add(ctr);
	if (size == G_renderQueueSet.size) return;
	if (G_renderQueueWorking) return;
	G_renderQueueWorking = true;

	utils.nextTick(function() {
		try {
			for( var item of G_renderQueueSet ) {
				rerender(item);
			}
		} finally {
			G_renderQueueWorking = false;
		}
	});
}

export interface DOMConstructor {
	new(...args: any[]): DOM;
	readonly isViewController: boolean;
}

/**
 * @class VirtualDOM
 */
export class VirtualDOM {
	readonly propsHash: number;
	readonly props: Dict<[any,number]>;
	readonly domConstructor: DOMConstructor;
	readonly children: (VirtualDOM | null)[];
	dom: DOM | null;
	hash: number;

	constructor(domConstructor: DOMConstructor, props: Dict | null, children: (VirtualDOM | null)[]) {
		var _propsHash = 0;
		var _props: Dict<[any,number]> = {};

		for (var prop in props) {
			var hashCode = 0;
			var value = props[prop];
			hashCode += (hashCode << 5) + prop.hashCode();
			hashCode += (hashCode << 5) + Object.hashCode(value);
			_props[prop] = [value,hashCode];
			_propsHash += (_propsHash << 5) + hashCode;
		}
		var _hash = (domConstructor.hashCode() << 5) + _propsHash;

		for (var vdom of children) {
			if (vdom) {
				_hash += (_hash << 5) + vdom.hash;
			}
		}

		this.domConstructor = domConstructor;
		this.props = _props;
		this.hash = _hash;
		this.propsHash = _propsHash;
		this.children = children;
	}

	getProp(name: string) {
		var prop = this.props[name];
		return prop ? prop[0]: null;
	}

	hasProp(name: string) {
		return name in this.props;
	}

	assignProps() {
		var props = this.props;
		for (var key in props) {
			(this.dom as any)[key] = props[key][0]; // assignProp
		}
	}

	diffProps(vdom: VirtualDOM) {
		if (this.propsHash != vdom.propsHash) {
			var props0 = this.props;
			var props1 = vdom.props;
			for (var key in props1) {
				var prop0 = props0[key], prop1 = props1[key];
				if (!prop0 || prop0[1] != prop1[1]) {
					(this.dom as any)[key] = prop1[0]; // assignProp
				}
			}
		}
	}

	newInstance(ctr: ViewController): DOM {
		utils.assert(!this.dom);
		var dom = new (this.domConstructor)();
		this.dom = dom;
		(dom as any).m_owner = ctr;

		if (this.domConstructor.isViewController) { // ctrl
			var newCtr = dom as ViewController;
			(newCtr as any).m_vchildren = this.children;
			this.assignProps(); // before set props
			var r = newCtr.triggerLoad(); // trigger event Load
			if (r instanceof Promise) {
				r.then(()=>(newCtr as any).m_loaded = true);
			} else {
				(newCtr as any).m_loaded = true
			}
			rerender(newCtr); // rerender
		} else {
			for (var vdom of this.children) {
				if (vdom)
					vdom.newInstance(ctr).appendTo(dom);
			}
			this.assignProps(); // after set props
		}

		return dom;
	}

	hashCode() {
		return this.hash;
	}
}

(VirtualDOM as any).prototype.dom = null;

/**
 * @class VirtualDOMCollection
 * @private
 */
class VirtualDOMCollection extends VirtualDOM {
	vdoms: VirtualDOM[];

	constructor(vdoms: (VirtualDOM | null)[]) {
		super(DOMCollection, {}, []);
		this.vdoms = vdoms.filter(e=>e) as VirtualDOM[];
		this.vdoms.forEach(e=>(this.hash += (this.hash << 5) + e.hash));
	}

	diffProps(vdom: VirtualDOM<DOM>) {
		var { vdoms, hash } = vdom as VirtualDOMCollection;
		var dom = this.dom as DOMCollection;
		var keys = {};
		var keys_c = (dom as any).m_keys; // private props visit
		var ctr = dom.owner;
		var prev = (dom as any).m_vdoms.length ? 
			(dom as any).m_vdoms[0].dom: (dom as any).m_placeholder; // DOMCollection placeholder or doms[0]

		utils.assert(prev);

		for (var i = 0; i < vdoms.length; i++) {
			var vdom = vdoms[i], key;
			if (vdom.hasProp('key')) {
				key = vdom.getProp('key');
			} else {
				warn('UndefinedDOMKey');
				key = '_$auto' + i; // auto key
			}
			if (keys[key]) {
				throw new Error('DOM Key definition duplication in DOM Collection, = ' + key);
			} else {
				keys[key] = vdom;
			}

			var vdom_c = keys_c[key];
			if (vdom_c) {
				if (vdom_c.hash != vdom.hash) {
					prev = diff(ctr, vdom_c, vdom, prev); // diff
				} else { // use old dom
					keys[key] = vdom_c;
					vdoms[i] = vdom_c;
					prev = vdom_c.dom.afterTo(prev);
				}
				delete keys_c[key];
			} else { // no key
				var cell = vdom.newInstance(ctr);
				prev = cell.afterTo(prev);
			}
		}

		if (vdoms.length) {
			if (dom.m_placeholder) {
				dom.m_placeholder.remove();
				dom.m_placeholder = null;
			}
		} else if (!dom.m_placeholder) {
			dom.m_placeholder = new View();
			dom.m_placeholder.afterTo(prev);
		}

		this.hash = hash;
		this.vdoms = vdoms;

		dom.m_vdoms = vdoms;
		dom.m_keys = keys;

		for (var key in keys_c) {
			removeDOM(ctr, keys_c[key]);
		}
	}

	newInstance(ctr: ViewController) {
		utils.assert(!this.dom);
		var vdoms = this.vdoms;
		var keys: Dict<VirtualDOM> = {};
		this.dom = new DOMCollection(ctr, vdoms, keys);

		for (var i = 0; i < vdoms.length; i++) {
			var vdom = vdoms[i], key;
			vdom.newInstance(ctr);
			if (vdom.hasProp('key')) {
				key = vdom.getProp('key');
			} else {
				warn('UndefinedDOMKey');
				key = '_$auto' + i; // auto key
			}
			if (keys[key]) {
				throw new Error('DOM Key definition duplication in DOM Collection, = ' + key);
			} else {
				keys[key] = vdom;
			}
		}

		return this.dom;
	}

}

function callDOMsFunc(self: DOMCollection, active: string, view: View) {
	if (self.m_placeholder) {
		return self.m_placeholder[active](view);
	} else {
		for (var cellView of self.m_vdoms) {
			cellView.dom[active](view);
		}
		return self.m_vdoms.last(0).dom;
	}
}

/**
 * @class DOMCollection DOM
 * @private
 */
class DOMCollection implements DOM {

	// @private:
	private m_owner: ViewController;
	private m_vdoms: VirtualDOM[];
	private m_keys: Dict<VirtualDOM>;
	private m_placeholder: View | null; // view placeholder	

	get meta() {
		return this.m_placeholder ? this.m_placeholder: (this.m_vdoms.indexReverse(0).dom as DOM).meta;
	}

	id = '';
	
	get owner() {
		return this.m_owner;
	}

	get collection() {
		return this.m_vdoms.map(e=>e.dom);
	}

	key(key: string) {
		var vdom = this.m_keys[key];
		// return this.m_keys[key];
	}

	constructor(owner: ViewController, vdoms: VirtualDOM[], keys: Dict<VirtualDOM>) {
		this.m_owner = owner;
		this.m_vdoms = vdoms;
		this.m_keys = keys;
		if (!vdoms.length) {
			this.m_placeholder = new View();
		}
	}

	remove() {
		if (this.m_placeholder) {
			this.m_placeholder.remove();
			this.m_placeholder = null;
		}
		else if (this.m_vdoms.length) {
			// var keys = this.m_keys;
			this.m_vdoms.forEach(vdom=>{
				// var key = vdom.key;
				// if (key) {
				// 	delete keys[key];
				// }
				removeDOM(this.m_owner, vdom);
			});
			this.m_vdoms = [];
			this.m_keys = {};
		}
	}

	appendTo(parentView: View) {
		return callDOMsFunc(this, 'appendTo', parentView);
	}

	afterTo(prevView: View) {
		return callDOMsFunc(this, 'afterTo', prevView);
	}

}

(DOMCollection as any).prototype.m_placeholder = null;

function removeSubctr(self: ViewController, vdom: VirtualDOM) {
	for (var e of vdom.children) {
		if (e) {
			if (e.type.isViewController) {
				e.dom.remove(); // remove ctrl
			} else {
				removeSubctr(self, e);
			}
		}
	}
	var id = vdom.dom.id;
	if (id) {
		if (self.m_IDs[id] === vdom.dom) {
			delete self.m_IDs[id];
		}
	}
}

function removeDOM(self: ViewController, vdom: VirtualDOM) {
	removeSubctr(self, vdom);
	vdom.dom.remove();
}

function diff(self: ViewController, vdom_c: VirtualDOM, vdom: VirtualDOM, prevView: View) {
	utils.assert(prevView);

	// diff type
	if (vdom_c.type !== vdom.type) {
		var r = vdom.newInstance(self).afterTo(prevView); // add new
		removeDOM(self, vdom_c); // del dom
		return r;
	}

	var dom = vdom_c.dom;
	vdom.dom = dom;

	// diff props
	vdom_c.diffProps(vdom); 

	var view = dom.__view__;

	// diff children
	var children_c = vdom_c.children;
	var children = vdom.children;

	if ( vdom.type.isViewController ) {
		if ( children_c.length || children.length ) {
			dom.m_vchildren = children;
			rerender(dom); // mark ctrl render
		}
	} else {
		var childrenCount = Math.max(children_c.length, children.length);

		for (var i = 0, prev = null; i < childrenCount; i++) {
			vdom_c = children_c[i];
			vdom = children[i];
			if (vdom_c) {
				if (vdom) {
					if (vdom_c.hash != vdom.hash) {
						prev = diff(self, vdom_c, vdom, prev || vdom_c.dom.__view__); // diff
					} else {
						children[i] = vdom_c;
						prev = vdom_c.dom.__view__;
					}
				} else {
					removeDOM(self, vdom_c); // remove DOM
				}
			} else {
				if (vdom) {
					var dom = vdom.newInstance(self);
					if (prev)
						prev = dom.afterTo(prev); // add
					else {
						var tmp = new View();
						view.prepend(tmp);
						prev = dom.afterTo(tmp); // add
						tmp.remove();
					}
				}
			}
		}
	} // if (vdom.type.isViewController) end

	return view;
}

function rerender(self: ViewController) {
	G_renderQueueSet.delete(self); // delete mark

	var vdom_c = self.m_vdom;
	var vdom = _CVDD(self.render(...self.m_vchildren));
	var update = false;

	if (vdom_c) {
		if (vdom) {
			if (vdom_c.hash != vdom.hash) {
				var prev = vdom_c.dom.__view__;
				utils.assert(prev);
				self.m_vdom = vdom;
				diff(self, vdom_c, vdom, prev); // diff
				update = true;
			}
		} else {
			var prev = vdom_c.dom.__view__;
			utils.assert(prev);
			utils.assert(!self.m_placeholder);
			self.m_placeholder = new View();
			self.m_placeholder.afterTo(prev);
			self.m_vdom = null;
			removeDOM(self, vdom_c); // del dom
			update = true;
		}
	} else {
		if (vdom) {
			self.m_vdom = vdom;
			vdom.newInstance(self);
			if (self.m_placeholder) {
				vdom.dom.afterTo(self.m_placeholder);
				self.m_placeholder.remove();
				self.m_placeholder = null;
			}
			update = true;
		} else {
			if (!self.m_placeholder) {
				self.m_placeholder = new View();
			}
		}
	}

	if (!self.m_mounted) {
		self.m_mounted = true;
		self.triggerMounted();
	}
	if (update) {
		self.triggerUpdate();
	}
}

function domInCtr(self: ViewController) {
	return self.m_vdom ? self.m_vdom.dom: self.m_placeholder;
}

/**
 * @func prop()
 * <pre>
 * 	class MyViewController extends ViewController {
 *		@prop width: number = 100;
 *		@prop height: number = 100;
 * 		render() {
 * 			return (
 * 				<Div width=this.width height=this.height>Hello</Div>
 * 			);
 * 		}
 * 	}
 * </pre>
 */

function defineProp<T extends typeof ViewController.prototype>(target: T, name: string, defaultValue?: any) {
	utils.assert(utils.equalsClass(ViewController, target.constructor), 'Type error');
	Object.defineProperty(target, name, {
		get: arguments.length < 3 ? function(this: any) {
			return this['m_' + name];
		}: typeof defaultValue == 'function' ? defaultValue: function(this: any) {
			return this['m_' + name] || defaultValue;
		},
		set(this: any, value: any) {
			var hashCode = Object.hashCode(value);
			var hash = this.m_dataHash;
			if (hash['__prop_' + name] != hashCode) {
				hash['__prop_' + name] = hashCode;
				this['m_' + name] = value;
				this.markRerender(); // mark render
			}
		},
		configurable: false,
		enumerable: true,
	});
}

export declare function prop<T extends typeof ViewController.prototype>(target: T, name: string): void;
export declare function prop(defaultValue: (()=>any) | any): <T extends typeof ViewController.prototype>(target: T, name: string)=>void;

exports.prop = function(defaultValueOrTarget: any, name?: string) {
	if (arguments.length < 2) {
		return function(target: any, name: any) {
			defineProp(target, name, defaultValueOrTarget);
		};
	} else {
		defineProp(defaultValueOrTarget, name as string);
	}
};

const _prop = exports.prop;

/**
 * @class ViewController DOM
 */
export class ViewController extends Notification<Event<any, ViewController>> implements DOM {
	private m_IDs: Dict<ViewController | View> = {};
	private m_vmodel: Dict = {}; // view modle
	private m_dataHash: Dict<number> = {}; // modle and props hash
	private m_id: string; // = null;     // id
	private m_owner: ViewController | null; // = null;  // owner controller
	private m_placeholder: View | null; // = null; // view placeholder	
	private m_vdom: VirtualDOM | null; // = null;     // children vdom
	private m_vchildren: VirtualDOM[]; // = []; // outer vdom children
	private m_loaded: boolean; // = false;
	private m_mounted: boolean; // = false;
	private m_style: Dict | null; // = null;

	get meta(): View {
		return this.m_vdom ? this.m_vdom.dom.__view__: this.m_placeholder;
	}

	@event readonly onLoad: EventNoticer<Event<void, ViewController>>;    // @event onLoad
	@event readonly onMounted: EventNoticer<Event<void, ViewController>>; // @event onMounted
	@event readonly onUpdate: EventNoticer<Event<void, ViewController>>;  // @event onUpdate
	@event readonly onRemove: EventNoticer<Event<void, ViewController>>;  // @event onRemove
	@event readonly onRemoved: EventNoticer<Event<void, ViewController>>; // @event onRemoved

	triggerLoad(): any {
		return this.trigger('Load');
	}

	triggerMounted(): any {
		return this.trigger('Mounted');
	}

	triggerUpdate(): any {
		return this.trigger('Update');
	}

	triggerRemove(): any {
		return this.trigger('Remove');
	}

	triggerRemoved(): any {
		return this.trigger('Removed');
	}

	static setID(dom: ViewController | View, id: string) {
		var _id = (dom as any).m_id;
		if (_id != id) {
			if ((dom as any).m_owner) {
				var ids = (dom as any).m_owner.m_IDs;
				if (ids[_id] === dom) {
					delete ids[_id];
				}
				if (id) {
					if (id in ids) {
						throw new Error('Identifier reference duplication in controller, = ' + id);
					}
					ids[id] = dom;
				}
			}
			(dom as any).m_id = id;
		}
	}

	get id() {
		return this.m_id;
	}

	set id(value: string) {
		ViewController.setID(this, value);
	}

	get IDs() {
		return this.m_IDs;
	}

	get owner() {
		return this.m_owner;
	}

	get dom(): DOM | null {
		return this.m_vdom ? this.m_vdom.dom: null;
	}

	get isLoaded() {
		return this.m_loaded;
	}

	get isMounted() {
		return this.m_mounted;
	}

	get model() {
		return this.m_vmodel;
	}

	set model(modle: Dict) {
		this.setModel(modle);
	}

	setModel(modle: Dict) {
		var update = false;
		var value = this.m_vmodel;
		var hash = this.m_dataHash;
		for (var key in modle) {
			var item = modle[key];
			var hashCode = Object.hashCode(item);
			if (hashCode != hash[key]) {
				value[key] = item;
				hash[key] = hashCode;
				update = true;
			}
		}
		if (update) {
			this.markRerender(); // mark render
		}
	}

	/*
	 * @func markRerender()
	 */
	markRerender() {
		markRerender(this);
	}

	/**
	 * @overwrite
	 */
	hashCode() {
		return Function.prototype.hashCode.call(this);
	}

	appendTo(parentView: View) {
		return domInCtr(this).appendTo(parentView);
	}

	afterTo(prevView: View) {
		return domInCtr(this).afterTo(prevView);
	}

	/**
	 * @overwrite
	 */
	addDefaultListener(name: string, func: Listen<Event<any, ViewController>> | string) {
		if ( typeof func == 'string' ) {
			var owner = this as any, func2;
			do {
				var func2 = owner[func];  // find func
				if ( typeof func2 == 'function' ) {
					return this.addEventListener(name, func2, owner, '0'); // default id 0
				}
				owner = owner.m_owner;
			} while(owner);
			throw Error.new(`Cannot find a function named "${func}"`);
		} else {
			return super.addDefaultListener(name, func);
		}
	}

	/**
	 * @func render(...vdoms)
	 */
	render(...vdoms: any[]): any {
		return vdoms;
	}

	remove() {
		var vdom = this.m_vdom;
		var placeholder = this.m_placeholder;

		if (vdom || placeholder) {

			var owner = this.m_owner;
			if (owner) {
				utils.assert(owner.dom !== this, 'Illegal call');
			}

			if (G_removeSet.has(this)) return;
			G_removeSet.add(this);
			try {
				this.triggerRemove(); // trigger Remove event
			} finally {
				G_removeSet.delete(this);
			}

			this.m_placeholder = null;
			this.m_vdom = null;

			if (vdom) {
				removeDOM(this, vdom);
			} else {
				(placeholder as View).remove();
			}
			this.triggerRemoved(); // trigger Removed
		}
	}

	/**
	 * @prop style
	 */
	@_prop(function(this: ViewController) {
		return this.m_style || {};
	})
	style: StyleSheet;

	/**
	 * @get isViewController
	 * @static
	 */
	static get isViewController() {
		return true;
	}

	/**
	 * @func typeOf(obj, [Type=class ViewController])
	 * @arg obj {VirtualDOM|View|ViewController|class}
	 * @static
	 */
	static typeOf(obj: any, Type: any) {
		Type = Type || ViewController;
		if (utils.equalsClass(ViewController, Type) || utils.equalsClass(View, Type)) {
			if (obj instanceof Type)
				return 3; // dom instance
			if (obj instanceof VirtualDOM) { 
				if (utils.equalsClass(Type, obj.type))
					return 2; // vdom instance
			}
			if (utils.equalsClass(Type, obj))
				return 1; // class
		}
		return 0;
	}

	/**
	 * @func render(obj, [parentView])
	 * @arg obj {VirtualDOM|View|ViewController|class}
	 * @ret {DOM} return dom instance
	 */
	static render(obj: any, parentView?: any) {
		var dom;
		var owner = parentView ? parentView.owner: null;

		if (obj instanceof ViewController || obj instanceof View) {
			dom = obj; // dom instance
		} else if (utils.equalsClass(ViewController, obj) || utils.equalsClass(View, obj)) {
			obj = _CVD(obj, null); // create vdom
			dom = obj.newInstance(owner);
		} else {
			obj = _CVDD(obj); // format vdom
			utils.assert(obj instanceof VirtualDOM, 'Bad argument');
			dom = obj.newInstance(owner);
		}
		if (parentView) {
			dom.appendTo(parentView);
			dom.m_owner = owner;
		}
		return dom;
	}

	static hashCode() {
		return Function.prototype.hashCode.call(this);
	}

}

(ViewController as any).prototype.m_id = '';
(ViewController as any).prototype.m_owner = null;
(ViewController as any).prototype.m_placeholder = null;
(ViewController as any).prototype.m_vdom = null;
(ViewController as any).prototype.m_vchildren = [];
(ViewController as any).prototype.m_loaded = false;
(ViewController as any).prototype.m_mounted = false;
(ViewController as any).prototype.m_style = null;

export default ViewController;

// create virtual dom TextNode
function _CVDT(value: string) {
	return new VirtualDOM(TextNode, {value}, []);
}

// create virtual dom dynamic
export function _CVDD(value: any): VirtualDOM | null {
	if (value instanceof VirtualDOM) {
		return value
	} else if (TEXT_NODE_VALUE_TYPE.has(typeof value)) {
		return _CVDT(value);
	} else if (Array.isArray(value)) {
		if (value.length) {
			return value.length == 1 ?
				_CVDD(value[0]): new VirtualDOMCollection(value.map(_CVDD));
		} else {
			return null;
		}
	}
	return value ? _CVDT(String(value)): null; // null or TextNode
}

// create virtual dom
export function _CVD<T extends typeof ViewController | typeof View>(Type: T, props: Dict | null, ...children: any[]) {
	return new VirtualDOM(Type, props, children);
}