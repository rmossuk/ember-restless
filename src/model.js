/*
 * Model
 * Base class for RESTful models
 */
(function() {

'use strict';

RESTless.Model = Em.Object.extend( RESTless.State, Em.Copyable, {
  /* 
   * id: unique id number, default primary id
   */
  id: RESTless.attr('number'),

  /*
   * currentRequest: stores the last ajax request as a property.
   * Useful for accessing the promise callbacks.
   * Automatically set to null when request completes
   */
  currentRequest: null,

  /* 
   * isNew: model has not yet been stored to REST service
   */
  isNew: function() {
    var primaryKey = Em.get(this.constructor, 'primaryKey');
    return Em.isNone(this.get(primaryKey));
  }.property(),

  /* 
   * init: on instance creation
   */
  init: function() {
    // Pre-fetch the attributeMap. Cached after 1 object of type is created
    var attributeMap = Em.get(this.constructor, 'attributeMap'),
        observable = !!!this.get('nonObservable'), attr;

    // Initialize relationships with proper model types.
    // Start observing *all* property changes for 'isDirty' functionality
    for(attr in attributeMap) {
      if (attributeMap.hasOwnProperty(attr)) {
        if(attributeMap[attr].get('hasMany')) {
          // create array of type & observe when contents of array changes
          this.set(attr, RESTless.RESTArray.createWithContent({type: attributeMap[attr].get('type')}));
          if(observable) { this.addObserver(attr+'.@each', this, this._onPropertyChange); }
        }
        else if(attributeMap[attr].get('belongsTo')) {
          // create model of type and observe when it changes
          this.set(attr, Em.get(window, attributeMap[attr].get('type')).create());
          if(observable) { this.addObserver(attr, this, this._onPropertyChange); }
        }
        else {
          if(observable) { this.addObserver(attr, this, this._onPropertyChange); }
        }
      }
    }
  },

  /* 
   * _onPropertyChange: (internal) called when any property of the model changes
   * If the model has been loaded from the REST service, or is new, isDirty flag is set to true.
   * If the property contains a 'parentObject' (hasMany array items), set the parent isDirty.
   */
  _onPropertyChange: function(sender, key) {
    var parent = this.get('parentObject'),
        targetObject = parent || this;
    if(targetObject.get('isLoaded') || targetObject.get('isNew')) {
      targetObject.set('isDirty', true);
    }
  },

  /* 
   * copy: creates a copy of the object. Implements Ember.Copyable protocol
   * http://emberjs.com/api/classes/Ember.Copyable.html#method_copy
   */
  copy: function(deep) {
    var clone = this.constructor.create(),
        attributeMap = Em.get(this.constructor, 'attributeMap'),
        attr, value;
        
    Em.beginPropertyChanges(this);
    for(attr in attributeMap) {
      if(attributeMap.hasOwnProperty(attr)) {
        value = this.get(attr);
        if(value !== null) { clone.set(attr, value); }
      }
    }
    Em.endPropertyChanges(this);
    return clone;
  },

  /* 
   * copyWithState: creates a copy of the object along with the RESTless.State properties
   */
  copyWithState: function(deep) {
    return this.copyState(this.copy(deep));
  },

  /* 
   * serialize: use the current Adapter turn the model into json representation
   */
  serialize: function() {
    return RESTless.get('client.adapter').serialize(this);
  },

  /* 
   * deserialize: use the current Adapter to set the model properties from supplied json
   */
  deserialize: function(json) {
    return RESTless.get('client.adapter').deserialize(this, json);
  },

  /* 
   * deserializeResource: (helper) deserializes a single, wrapped resource. i.e:
   * { post: { id:1, name:'post 1' } }
   * This is the json format returned from Rails ActiveRecord on create or update
   */
  deserializeResource: function(json) {
    var resourceName = Em.get(this.constructor, 'resourceName');
    return this.deserialize(json[resourceName]);
  },

  /*
   * request: returns an ajax request from the current Adapter.
   * Attemps to extract a resource id and keeps state of the currentRequest
   */
  request: function(params) {
    var resourceName = Em.get(this.constructor, 'resourceNamePlural'),
        resourceIdKey = Em.get(this.constructor, 'primaryKey'),
        resourceId = this.get(resourceIdKey),
        self = this,
        request;

    if(!resourceId && params.data && params.data.id) {
      resourceId = params.data.id;
      delete params.data.id;
    }
    // Get the ajax request
    request = RESTless.get('client.adapter').request(params, resourceName, resourceId);

    // Store a reference to the active request and destroy it when finished
    this.set('currentRequest', request);
    request.always(function() {
      self.set('currentRequest', null);
    });
    return request;
  },

  /*
   * saveRecord: POSTs a new record, or PUTs an updated record to REST service
   */
  saveRecord: function() {
    //If an existing model isn't dirty, no need to save.
    if(!this.get('isNew') && !this.get('isDirty')) {
      return $.Deferred().resolve();
    }
    this.set('isSaving', true);

    var self = this,
        isNew = this.get('isNew'), // purposely cache value for triggering correct event later
        method = isNew ? 'POST' : 'PUT',
        saveRequest = this.request({ type: method, data: this.serialize() });

    saveRequest.done(function(json){
      self.deserializeResource(json);
      self.clearErrors();
      self.set('isDirty', false);
      self._triggerEvent(isNew ? 'didCreate' : 'didUpdate');
    })
    .fail(function(jqxhr) {
      self._onError(jqxhr.responseText);
    })
    .always(function() {
      self.set('isSaving', false);
      self.set('isLoaded', true);
      self._triggerEvent('didLoad');
    });

    return saveRequest;
  },

  /*
   * deleteRecord: DELETEs record from REST service
   */
  deleteRecord: function() {
    var self = this,
        deleteRequest = this.request({ type: 'DELETE', data: this.serialize() });
        
    deleteRequest.done(function(){
      self._triggerEvent('didDelete');
      self.destroy();
    })
    .fail(function(jqxhr) {
      self._onError(jqxhr.responseText);
    });
    return deleteRequest;
  }
});

/*
 * RESTless.Model (static)
 * Class level properties and methods
 */
RESTless.Model.reopenClass({
  /* 
   * primaryKey: property name for the primary key.
   * Configurable. Defaults to 'id'.
   */
  primaryKey: function() {
    var className = this.toString(),
        modelConfig = Ember.get('RESTless.client.adapter.configurations.models').get(className);
    if(modelConfig && modelConfig.primaryKey) {
      return modelConfig.primaryKey;
    }
    return 'id';
  }.property('RESTless.client.adapter.configurations.models'),

  /*
   * resourceName: path to the resource endpoint, determined from class name
   * i.e. MyApp.Post = RESTless.Model.extend({ ... })  =>  'post'
   */
  resourceName: function() {
    var className = this.toString(),
        parts = className.split('.');
    return parts[parts.length-1].toLowerCase();
  }.property(),

  /*
   * resourceNamePlural: resourceName pluralized
   * Define custom plural words in a custom adapter
   */
  resourceNamePlural: function() {
    var name = Em.get(this, 'resourceName'),
        plurals = RESTless.get('client.adapter.configurations').plurals;
    return (plurals && plurals[name]) || name + 's';
  }.property('resourceName'),

  /*
   * attributeMap: stores all of the RESTless Attribute definitions.
   * This should be pre-fetched before attemping to get/set properties on the model object.
   */
  attributeMap: function() {
    var proto = this.prototype,
        attributeMap = {},
        key;
    for(key in proto) {
      if(proto[key] instanceof RESTless._Attribute) {
        attributeMap[key] = proto[key];
        this.prototype[key] = null; //clear the prototype after collection
      }
    }
    return attributeMap;
  }.property(),

  /*
   * find: fetches a single resource with an id as the param.
   * Also an alias to findAll objects of this type with specified params
   */
  find: function(params) {
    var singleResourceRequest = typeof params === 'string' || typeof params === 'number';
    if(singleResourceRequest) {
      return this._findById(params);
    } else {
      return this.findAll(params);
    }
  },

  /*
   * findAll: fetches all objects of this type with specified params
   */
  findAll: function(params) {
    var self = this,
        resourceNamePlural = Em.get(this, 'resourceNamePlural'),
        resourceInstance = this.create(),
        result = RESTless.RESTArray.createWithContent({ type: this.toString() }),
        findRequest = resourceInstance.request({ type: 'GET', data: params });

    findRequest.done(function(json){
      result.deserializeMany(json[resourceNamePlural]);
      result.clearErrors();
      //call extract metadata hook
      var meta = RESTless.get('client.adapter').extractMeta(json);
      if(meta) { result.set('meta', meta); }
    })
    .fail(function(jqxhr) {
      result._onError(jqxhr.responseText);
    })
    .always(function() {
      result.set('isLoaded', true);
      result._triggerEvent('didLoad');
    });
    return result;
  },

  /*
   * _findById: (internal) fetches object with specified id
   * 'find' handles all cases, and reroutes to here if necessary
   */
  _findById: function(id) {
    var resourceName = Em.get(this, 'resourceName'),
        result = this.create(),
        findRequest = result.request({ type: 'GET', data: {id: id} });

    findRequest.done(function(json){
      result.deserialize(json[resourceName]);
      result.clearErrors();
    })
    .fail(function(jqxhr) {
      result._onError(jqxhr.responseText);
    })
    .always(function() {
      result.set('isLoaded', true);
      result._triggerEvent('didLoad');
    });
    return result;
  }
});

})();
