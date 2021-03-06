<a name="module_adapter"></a>
## adapter
Promise Adapter

**Author:** Vitaly Tomilov  
<a name="module_adapter.PromiseAdapter"></a>
### adapter.PromiseAdapter
Provides compatibility with promise libraries that cannot be recognized automatically,via functions that implement the primary operations with promises: - construct a new promise with a callback function - resolve a promise with some result data - reject a promise with a reason

**Kind**: static class of <code>[adapter](#module_adapter)</code>  
**Summary**: Adapter for the primary promise operations.  
<table>
  <thead>
    <tr>
      <th>Param</th><th>Type</th><th>Description</th>
    </tr>
  </thead>
  <tbody>
<tr>
    <td>create</td><td><code>function</code></td><td><p>A function that takes a callback parameter and returns a new promise object.
The callback parameter is expected to be <code>function(resolve, reject)</code>.</p>
<p>Passing in anything other than a function will throw <code>Adapter requires a function to create a promise.</code></p>
</td>
    </tr><tr>
    <td>resolve</td><td><code>function</code></td><td><p>A function that takes an optional data parameter and resolves a promise with it.</p>
<p>Passing in anything other than a function will throw <code>Adapter requires a function to resolve a promise.</code></p>
</td>
    </tr><tr>
    <td>reject</td><td><code>function</code></td><td><p>A function that takes an optional error parameter and rejects a promise with it.</p>
<p>Passing in anything other than a function will throw <code>Adapter requires a function to reject a promise.</code></p>
</td>
    </tr>  </tbody>
</table>

